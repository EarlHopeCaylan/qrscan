export default class QrScanner {
    /* async */
    static hasCamera() {
        return QrScanner.listCameras(false)
            .then(cameras => !!cameras.length)
            .catch(() => false);
    }

    /* async */
    static listCameras(requestLabels = false) {
        if (!navigator.mediaDevices) return Promise.resolve([]);

        // Note that enumerateDevices can always be called and does not prompt the user for permission.
        // However, enumerateDevices only includes device labels if served via https and an active media stream exists
        // or permission to access the camera was given. Therefore, ask for camera permission by opening a stream, if
        // labels were requested.
        let openedStream = null;
        return (requestLabels
            ? navigator.mediaDevices.getUserMedia({ audio: false, video: true })
                .then(stream => openedStream = stream)
                // Fail gracefully, especially if the device has no camera or on mobile when the camera is already in
                // use and some browsers disallow a second stream.
                .catch(() => {})
            : Promise.resolve()
        )
            .then(() => navigator.mediaDevices.enumerateDevices())
            .then(devices => devices.filter(device => device.kind === 'videoinput').map((device, i) => ({
                id: device.deviceId,
                label: device.label || (i === 0 ? 'Default Camera' : `Camera ${i + 1}`),
            })))
            .finally(() => {
                // close the stream we just opened for getting camera access for listing the device labels
                if (!openedStream) return;
                for (const track of openedStream.getTracks()) {
                    track.stop();
                    openedStream.removeTrack(track);
                }
            });
    }

    constructor(
        video,
        onDecode,
        canvasSizeOrOnDecodeError = this._onDecodeError,
        canvasSizeOrCalculateScanRegion = this._calculateScanRegion,
        preferredCamera = 'environment'
    ) {
        this.$video = video;
        this.$canvas = document.createElement('canvas');
        this._onDecode = onDecode;
        this._legacyCanvasSize = QrScanner.DEFAULT_CANVAS_SIZE;
        this._preferredCamera = preferredCamera;
        this._active = false;
        this._paused = false;
        this._flashOn = false;

        if (typeof canvasSizeOrOnDecodeError === 'number') {
            // legacy function signature where the third argument is the canvas size
            this._legacyCanvasSize = canvasSizeOrOnDecodeError;
            console.warn('You\'re using a deprecated version of the QrScanner constructor which will be removed in '
                + 'the future');
        } else {
            this._onDecodeError = canvasSizeOrOnDecodeError;
        }

        if (typeof canvasSizeOrCalculateScanRegion === 'number') {
            // legacy function signature where the fourth argument is the canvas size
            this._legacyCanvasSize = canvasSizeOrCalculateScanRegion;
            console.warn('You\'re using a deprecated version of the QrScanner constructor which will be removed in '
                + 'the future');
        } else {
            this._calculateScanRegion = canvasSizeOrCalculateScanRegion;
        }

        this._scanRegion = this._calculateScanRegion(video);

        this._onPlay = this._onPlay.bind(this);
        this._onLoadedMetaData = this._onLoadedMetaData.bind(this);
        this._onVisibilityChange = this._onVisibilityChange.bind(this);

        video.disablePictureInPicture = true;
        // Allow inline playback on iPhone instead of requiring full screen playback,
        // see https://webkit.org/blog/6784/new-video-policies-for-ios/
        video.playsInline = true;
        // Allow play() on iPhone without requiring a user gesture. Should not really be needed as camera stream
        // includes no audio, but just to be safe.
        video.muted = true;

        // Avoid Safari stopping the video stream on a hidden video.
        // See https://github.com/cozmo/jsQR/issues/185
        let shouldHideVideo = false;
        if (video.hidden) {
            video.hidden = false;
            shouldHideVideo = true;
        }
        if (!document.body.contains(video)) {
            document.body.appendChild(video);
            shouldHideVideo = true;
        }
        requestAnimationFrame(() => {
            // Checking in requestAnimationFrame which should avoid a potential additional re-flow for getComputedStyle.
            const computedStyle = window.getComputedStyle(video);
            if (computedStyle.display === 'none') {
                video.style.setProperty('display', 'block', 'important');
                shouldHideVideo = true;
            }
            if (computedStyle.visibility !== 'visible') {
                video.style.setProperty('visibility', 'visible', 'important');
                shouldHideVideo = true;
            }
            if (shouldHideVideo) {
                // Hide the video in a way that doesn't cause Safari to stop the playback.
                console.warn('QrScanner has overwritten the video hiding style to avoid Safari stopping the playback.');
                video.style.opacity = 0;
                video.style.width = 0;
                video.style.height = 0;
            }
        });

        video.addEventListener('play', this._onPlay);
        video.addEventListener('loadedmetadata', this._onLoadedMetaData);
        document.addEventListener('visibilitychange', this._onVisibilityChange);

        this._qrEnginePromise = QrScanner.createQrEngine();
    }

    /* async */
    hasFlash() {
        if (!('ImageCapture' in window)) {
            return Promise.resolve(false);
        }

        const track = this.$video.srcObject ? this.$video.srcObject.getVideoTracks()[0] : null;
        if (!track) {
            return Promise.reject('Camera not started or not available');
        }

        const imageCapture = new ImageCapture(track);
        return imageCapture.getPhotoCapabilities()
            .then((result) => {
                return result.fillLightMode.includes('flash');
            })
            .catch((error) => {
                console.warn(error);
                return false;
            });
    }

    isFlashOn() {
      return this._flashOn;
    }

    /* async */
    toggleFlash() {
      return this._setFlash(!this._flashOn);
    }

    /* async */
    turnFlashOff() {
      return this._setFlash(false);
    }

    /* async */
    turnFlashOn() {
      return this._setFlash(true);
    }

    destroy() {
        this.$video.removeEventListener('loadedmetadata', this._onLoadedMetaData);
        this.$video.removeEventListener('play', this._onPlay);
        document.removeEventListener('visibilitychange', this._onVisibilityChange);

        this.stop();
        QrScanner._postWorkerMessage(this._qrEnginePromise, 'close');
    }

    /* async */
    start() {
        if (this._active && !this._paused) {
            return Promise.resolve();
        }
        if (window.location.protocol !== 'https:') {
            // warn but try starting the camera anyways
            console.warn('The camera stream is only accessible if the page is transferred via https.');
        }
        this._active = true;
        if (document.hidden) {
            // camera will be started as soon as tab is in foreground
            return Promise.resolve();
        }
        this._paused = false;
        if (this.$video.srcObject) {
            // camera stream already/still set
            this.$video.play();
            return Promise.resolve();
        }

        let facingModeGuess = this._preferredCamera === 'environment' || this._preferredCamera === 'user'
            ? this._preferredCamera
            : null;
        return this._getCameraStream(this._preferredCamera, true)
            .catch(() => {
                // If _preferredCamera was a facing mode, we (probably) don't have a camera of the requested facing mode
                // and switch our facing mode guess.
                facingModeGuess = facingModeGuess === 'environment'
                    ? 'user' // switch as the requested facing mode was not available
                    : 'environment'; // switch, or also assume 'environment' as default if facingModeGuess was null
                // Retry unconstrained. Throws if camera is not accessible (e.g. due to not https)
                return this._getCameraStream();
            })
            .then(stream => {
                // Try to determine the facing mode from the stream, otherwise use our guess or 'environment' as
                // default. Note that the guess is not always accurate as Safari returns cameras of different facing
                // mode, even for exact facingMode constraints.
                facingModeGuess = this._getFacingMode(stream) || facingModeGuess || 'environment';
                this.$video.srcObject = stream;
                this.$video.play();
                this._setVideoMirror(facingModeGuess);

                // Restart the flash if it was previously on
                if (this._flashOn) {
                    this.turnFlashOn().catch(() => {});
                }
            })
            .catch(e => {
                this._active = false;
                throw e;
            });
    }

    stop() {
        this.pause();
        this._active = false;
    }

    pause(stopStreamImmediately = false) {
        this._paused = true;
        if (!this._active) {
            return Promise.resolve(true);
        }
        this.$video.pause();

        const stopStream = () => {
            const tracks = this.$video.srcObject ? this.$video.srcObject.getTracks() : [];
            for (const track of tracks) {
                track.stop(); //  note that this will also automatically turn the flashlight off
                this.$video.srcObject.removeTrack(track);
            }
            this.$video.srcObject = null;
        };

        if (stopStreamImmediately) {
            stopStream();
            return Promise.resolve(true);
        }

        return new Promise((resolve) => setTimeout(resolve, 300))
            .then(() => {
                if (!this._paused) return false;
                stopStream();
                return true;
            });
    }

    /* async */
    setCamera(facingModeOrDeviceId) {
        if (facingModeOrDeviceId === this._preferredCamera) return Promise.resolve();
        this._preferredCamera = facingModeOrDeviceId;
        // Restart the scanner with the new camera which will also update the video mirror and the scan region. Note
        // that we always pause the stream and not only if !this._paused as even if this._paused === true, the stream
        // might still be running, as it's by default only stopped after a delay of 300ms.
        const wasPaused = this._paused;
        return this.pause(true).then((paused) => {
            if (!paused || wasPaused || !this._active) return;
            return this.start();
        });
    }

    /* async */
    static scanImage(imageOrFileOrUrl, scanRegion=null, qrEngine=null, canvas=null, disallowCanvasResizing=false,
                     alsoTryWithoutScanRegion=false) {
        const gotExternalWorker = qrEngine instanceof Worker;

        let promise = Promise.all([
            qrEngine || QrScanner.createQrEngine(),
            QrScanner._loadImage(imageOrFileOrUrl),
        ]).then(([engine, image]) => {
            qrEngine = engine;
            let canvasContext;
            [canvas, canvasContext] = this._drawToCanvas(image, scanRegion, canvas, disallowCanvasResizing);

            if (qrEngine instanceof Worker) {
                if (!gotExternalWorker) {
                    // Enable scanning of inverted color qr codes. Not using _postWorkerMessage as it's async
                    qrEngine.postMessage({ type: 'inversionMode', data: 'both' });
                }
                return new Promise((resolve, reject) => {
                    let timeout, onMessage, onError;
                    onMessage = event => {
                        if (event.data.type !== 'qrResult') {
                            return;
                        }
                        qrEngine.removeEventListener('message', onMessage);
                        qrEngine.removeEventListener('error', onError);
                        clearTimeout(timeout);
                        if (event.data.data !== null) {
                            resolve(event.data.data);
                        } else {
                            reject(QrScanner.NO_QR_CODE_FOUND);
                        }
                    };
                    onError = (e) => {
                        qrEngine.removeEventListener('message', onMessage);
                        qrEngine.removeEventListener('error', onError);
                        clearTimeout(timeout);
                        const errorMessage = !e ? 'Unknown Error' : (e.message || e);
                        reject('Scanner error: ' + errorMessage);
                    };
                    qrEngine.addEventListener('message', onMessage);
                    qrEngine.addEventListener('error', onError);
                    timeout = setTimeout(() => onError('timeout'), 10000);
                    const imageData = canvasContext.getImageData(0, 0, canvas.width, canvas.height);
                    qrEngine.postMessage({
                        type: 'decode',
                        data: imageData
                    }, [imageData.data.buffer]);
                });
            } else {
                return new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => reject('Scanner error: timeout'), 10000);
                    qrEngine.detect(canvas).then(scanResults => {
                        if (!scanResults.length) {
                            reject(QrScanner.NO_QR_CODE_FOUND);
                        } else {
                            resolve(scanResults[0].rawValue);
                        }
                    }).catch((e) => reject('Scanner error: ' + (e.message || e))).finally(() => clearTimeout(timeout));
                });
            }
        });

        if (scanRegion && alsoTryWithoutScanRegion) {
            promise = promise.catch(() =>
                QrScanner.scanImage(imageOrFileOrUrl, null, qrEngine, canvas, disallowCanvasResizing));
        }

        promise = promise.finally(() => {
            if (gotExternalWorker) return;
            QrScanner._postWorkerMessage(qrEngine, 'close');
        });

        return promise;
    }

    setGrayscaleWeights(red, green, blue, useIntegerApproximation = true) {
        // Note that for the native BarcodeDecoder, this is a no-op. However, the native implementations work also
        // well with colored qr codes.
        QrScanner._postWorkerMessage(
            this._qrEnginePromise,
            'grayscaleWeights',
            { red, green, blue, useIntegerApproximation }
        );
    }

    setInversionMode(inversionMode) {
        // Note that for the native BarcodeDecoder, this is a no-op. However, the native implementations scan normal
        // and inverted qr codes by default
        QrScanner._postWorkerMessage(this._qrEnginePromise, 'inversionMode', inversionMode);
    }

    /* async */
    static createQrEngine(workerPath = QrScanner.WORKER_PATH) {
        return ('BarcodeDetector' in window ? BarcodeDetector.getSupportedFormats() : Promise.resolve([]))
            .then((supportedFormats) => supportedFormats.indexOf('qr_code') !== -1
                ? new BarcodeDetector({ formats: ['qr_code'] })
                : new Worker(workerPath)
            );
    }

    _onPlay() {
        this._scanRegion = this._calculateScanRegion(this.$video);
        this._scanFrame();
    }

    _onLoadedMetaData() {
        this._scanRegion = this._calculateScanRegion(this.$video);
    }

    _onVisibilityChange() {
        if (document.hidden) {
            this.pause();
        } else if (this._active) {
            this.start();
        }
    }

    _calculateScanRegion(video) {
        // Default scan region calculation. Note that this can be overwritten in the constructor.
        const smallestDimension = Math.min(video.videoWidth, video.videoHeight);
        const scanRegionSize = Math.round(2 / 3 * smallestDimension);
        return {
            x: Math.round((video.videoWidth - scanRegionSize) / 2),
            y: Math.round((video.videoHeight - scanRegionSize) / 2),
            width: scanRegionSize,
            height: scanRegionSize,
            downScaledWidth: this._legacyCanvasSize,
            downScaledHeight: this._legacyCanvasSize,
        };
    }

    _scanFrame() {
        if (!this._active || this.$video.paused || this.$video.ended) return false;
        // using requestAnimationFrame to avoid scanning if tab is in background
        requestAnimationFrame(() => {
            if (this.$video.readyState <= 1) {
                // Skip scans until the video is ready as drawImage() only works correctly on a video with readyState
                // > 1, see https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/drawImage#Notes.
                // This also avoids false positives for videos paused after a successful scan which remains visible on
                // the canvas until the video is started again and ready.
                this._scanFrame();
                return;
            }
            this._qrEnginePromise
                .then((qrEngine) => QrScanner.scanImage(this.$video, this._scanRegion, qrEngine, this.$canvas))
                .then(this._onDecode, (error) => {
                    if (!this._active) return;
                    const errorMessage = error.message || error;
                    if (errorMessage.indexOf('service unavailable') !== -1) {
                        // When the native BarcodeDetector crashed, create a new one
                        this._qrEnginePromise = QrScanner.createQrEngine();
                    }
                    this._onDecodeError(error);
                })
                .then(() => this._scanFrame());
        });
    }

    _onDecodeError(error) {
        // default error handler; can be overwritten in the constructor
        if (error === QrScanner.NO_QR_CODE_FOUND) return;
        console.log(error);
    }

    _getCameraStream(preferredCamera, exact = false) {
        const constraintsToTry = [{
            width: { min: 1024 }
        }, {
            width: { min: 768 }
        }, {}];

        if (preferredCamera) {
            const preferenceType = preferredCamera === 'environment' || preferredCamera === 'user'
                ? 'facingMode'
                : 'deviceId';
            if (exact) {
                preferredCamera = { exact: preferredCamera };
            }
            constraintsToTry.forEach(constraint => constraint[preferenceType] = preferredCamera);
        }

        return this._getMatchingCameraStream(constraintsToTry);
    }

    _getMatchingCameraStream(constraintsToTry) {
        if (!navigator.mediaDevices || constraintsToTry.length === 0) {
            return Promise.reject('Camera not found.');
        }
        return navigator.mediaDevices.getUserMedia({
            video: constraintsToTry.shift()
        }).catch(() => this._getMatchingCameraStream(constraintsToTry));
    }

    /* async */
    _setFlash(on) {
        this._flashOn = on;
        if (on && (!this._active || this._paused)) return Promise.resolve(); // will be started later on .start
        return this.hasFlash().then((hasFlash) => {
            if (!hasFlash) return Promise.reject('No flash available');
            // Note that the video track is guaranteed to exist at this point
            return this.$video.srcObject.getVideoTracks()[0].applyConstraints({
                advanced: [{ torch: on }],
            });
        }).catch((e) => {
            this._flashOn = !on;
            throw e;
        });
    }

    _setVideoMirror(facingMode) {
        // in user facing mode mirror the video to make it easier for the user to position the QR code
        const scaleFactor = facingMode==='user'? -1 : 1;
        this.$video.style.transform = 'scaleX(' + scaleFactor + ')';
    }

    _getFacingMode(videoStream) {
        const videoTrack = videoStream.getVideoTracks()[0];
        if (!videoTrack) return null; // unknown
        // inspired by https://github.com/JodusNodus/react-qr-reader/blob/master/src/getDeviceId.js#L13
        return /rear|back|environment/i.test(videoTrack.label)
            ? 'environment'
            : /front|user|face/i.test(videoTrack.label)
                ? 'user'
                : null; // unknown
    }

    static _drawToCanvas(image, scanRegion=null, canvas=null, disallowCanvasResizing=false) {
        canvas = canvas || document.createElement('canvas');
        const scanRegionX = scanRegion && scanRegion.x? scanRegion.x : 0;
        const scanRegionY = scanRegion && scanRegion.y? scanRegion.y : 0;
        const scanRegionWidth = scanRegion && scanRegion.width? scanRegion.width : image.width || image.videoWidth;
        const scanRegionHeight = scanRegion && scanRegion.height? scanRegion.height : image.height || image.videoHeight;

        if (!disallowCanvasResizing) {
            const canvasWidth = scanRegion && scanRegion.downScaledWidth
                ? scanRegion.downScaledWidth
                : scanRegionWidth;
            const canvasHeight = scanRegion && scanRegion.downScaledHeight
                ? scanRegion.downScaledHeight
                : scanRegionHeight;
            // Setting the canvas width or height clears the canvas, even if the values didn't change, therefore only
            // set them if they actually changed.
            if (canvas.width !== canvasWidth) {
                canvas.width = canvasWidth;
            }
            if (canvas.height !== canvasHeight) {
                canvas.height = canvasHeight;
            }
        }

        const context = canvas.getContext('2d', { alpha: false });
        context.imageSmoothingEnabled = false; // gives less blurry images
        context.drawImage(
            image,
            scanRegionX, scanRegionY, scanRegionWidth, scanRegionHeight,
            0, 0, canvas.width, canvas.height
        );
        return [canvas, context];
    }

    /* async */
    static _loadImage(imageOrFileOrBlobOrUrl) {
        if (imageOrFileOrBlobOrUrl instanceof HTMLCanvasElement || imageOrFileOrBlobOrUrl instanceof HTMLVideoElement
            || window.ImageBitmap && imageOrFileOrBlobOrUrl instanceof window.ImageBitmap
            || window.OffscreenCanvas && imageOrFileOrBlobOrUrl instanceof window.OffscreenCanvas) {
            return Promise.resolve(imageOrFileOrBlobOrUrl);
        } else if (imageOrFileOrBlobOrUrl instanceof Image) {
            return QrScanner._awaitImageLoad(imageOrFileOrBlobOrUrl).then(() => imageOrFileOrBlobOrUrl);
        } else if (imageOrFileOrBlobOrUrl instanceof File || imageOrFileOrBlobOrUrl instanceof Blob
            || imageOrFileOrBlobOrUrl instanceof URL || typeof(imageOrFileOrBlobOrUrl)==='string') {
            const image = new Image();
            if (imageOrFileOrBlobOrUrl instanceof File || imageOrFileOrBlobOrUrl instanceof Blob) {
                image.src = URL.createObjectURL(imageOrFileOrBlobOrUrl);
            } else {
                image.src = imageOrFileOrBlobOrUrl;
            }
            return QrScanner._awaitImageLoad(image).then(() => {
                if (imageOrFileOrBlobOrUrl instanceof File || imageOrFileOrBlobOrUrl instanceof Blob) {
                    URL.revokeObjectURL(image.src);
                }
                return image;
            });
        } else {
            return Promise.reject('Unsupported image type.');
        }
    }

    /* async */
    static _awaitImageLoad(image) {
        return new Promise((resolve, reject) => {
            if (image.complete && image.naturalWidth!==0) {
                // already loaded
                resolve();
            } else {
                let onLoad, onError;
                onLoad = () => {
                    image.removeEventListener('load', onLoad);
                    image.removeEventListener('error', onError);
                    resolve();
                };
                onError = () => {
                    image.removeEventListener('load', onLoad);
                    image.removeEventListener('error', onError);
                    reject('Image load error');
                };
                image.addEventListener('load', onLoad);
                image.addEventListener('error', onError);
            }
        });
    }

    /* async */
    static _postWorkerMessage(qrEngineOrQrEnginePromise, type, data) {
        return Promise.resolve(qrEngineOrQrEnginePromise).then((qrEngine) => {
            if (!(qrEngine instanceof Worker)) return;
            qrEngine.postMessage({ type, data });
        });
    }
}
QrScanner.DEFAULT_CANVAS_SIZE = 400;
QrScanner.NO_QR_CODE_FOUND = 'No QR code found';
QrScanner.WORKER_PATH = 'qr-scanner-worker.min.js';
