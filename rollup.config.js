import sourcemaps from 'rollup-plugin-sourcemaps';
// ts config is a combination of tsconfig.json and overrides here. Type declarations file is generated separately via
// tsc (see build script in package.json), because rollup can not emit multiple files if using output.file option.
import typescript from '@rollup/plugin-typescript';
import closureCompiler from '@ampproject/rollup-plugin-closure-compiler';

// not using rollup's output.banner/output.intro/output.footer/output.outro as we also have to modify the generated code
function workerScriptToDynamicImport() {
    return {
        name: 'worker-script-to-dynamic-import',
        generateBundle(options, bundle) {
            for (const chunkName of Object.keys(bundle)) {
                const chunk = bundle[chunkName];
                if (chunk.type !== 'chunk') {
                    continue;
                }
                chunk.code = 'export default new Worker(URL.createObjectURL(new Blob([`'
                    + chunk.code.replace(/`/g, '\\`').replace(/\${/g, '\\${')
                    + '`]),{type: "application/javascript"}))';
            }
        },
    };
}

export default [{
    // library
    input: 'src/qr-scanner.ts',
    external: ['./qr-scanner-worker.min.js'],
    output: [{
        file: 'qr-scanner.min.js',
        format: 'esm',
        interop: false,
        sourcemap: true,
    }, {
        file: 'qr-scanner.umd.min.js',
        format: 'umd',
        name: 'QrScanner',
        interop: false,
        sourcemap: true,
    }],
    plugins: [
        typescript({
            target: 'ES2017',
        }),
        closureCompiler({
            language_in: 'ECMASCRIPT_2017',
            language_out: 'ECMASCRIPT_2017',
            rewrite_polyfills: false,
        })
    ]
}, {
    // library legacy build
    input: 'src/qr-scanner.ts',
    external: ['./qr-scanner-worker.min.js'],
    output: [{
        file: 'qr-scanner.legacy.min.js',
        format: 'esm',
        interop: false,
        sourcemap: true,
    }],
    plugins: [
        typescript({
            target: 'ES2017',
        }),
        closureCompiler({
            language_in: 'ECMASCRIPT_2017',
            language_out: 'ECMASCRIPT6',
            rewrite_polyfills: false,
        })
    ]
}, {
    // worker
    input: 'src/worker.ts',
    output: {
        file: 'qr-scanner-worker.min.js',
        format: 'iife',
        interop: false,
        sourcemap: true,
    },
    plugins: [
        typescript(),
        sourcemaps(),
        closureCompiler({
            //compilation_level: 'ADVANCED',
            //warning_level: 'QUIET',
            language_in: 'ECMASCRIPT6',
            language_out: 'ECMASCRIPT6',
            rewrite_polyfills: false,
        }),
        workerScriptToDynamicImport(),
    ]
}];
