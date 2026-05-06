/**
 * Node-compatible esbuild script for matrix-link-language.
 * Use when Deno is not available: `npx tsx esbuild.node.ts`
 */
import * as esbuild from "esbuild";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ad4mLdkEntry = process.env.AD4M_LDK_ENTRY ||
    path.resolve(__dirname, "../ad4m/ad4m-ldk/js/lib/index.js");

const ad4mLdkAliasPlugin: esbuild.Plugin = {
    name: "ad4m-ldk-alias",
    setup(build) {
        build.onResolve({ filter: /^ad4m:host$/ }, () => ({
            path: "ad4m:host",
            external: true,
        }));
        build.onResolve({ filter: /^@coasys\/ad4m-ldk$/ }, () => ({
            path: ad4mLdkEntry,
            namespace: "file",
        }));
    },
};

const tsResolverPlugin: esbuild.Plugin = {
    name: "ts-resolver",
    setup(build) {
        build.onResolve({ filter: /\.js$/ }, (args) => {
            if (args.namespace !== "file" || !args.path.startsWith(".")) return;
            // Only resolve .js → .ts for local source files, not dependencies
            const resolved = path.resolve(args.resolveDir, args.path);
            if (!resolved.startsWith(__dirname)) return;
            const tsPath = args.path.replace(/\.js$/, ".ts");
            const tsResolved = path.resolve(args.resolveDir, tsPath);
            return { path: tsResolved, namespace: "file" };
        });
    },
};

const result = await esbuild.build({
    entryPoints: [path.resolve(__dirname, "index.ts")],
    outfile: path.resolve(__dirname, "build/bundle.js"),
    bundle: true,
    platform: "neutral",
    target: "es2022",
    format: "esm",
    charset: "ascii",
    legalComments: "inline",
    plugins: [ad4mLdkAliasPlugin, tsResolverPlugin],
});

if (result.errors.length > 0) {
    console.error("Build failed:", result.errors);
    process.exit(1);
}
console.log("✅ Bundle written to build/bundle.js");
