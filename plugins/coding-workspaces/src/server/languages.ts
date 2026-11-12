/**
 * THE LANGUAGE TABLE (ported from the fork's practice workspaces). Coding
 * questions accept any language name; this maps the ones with a sandbox image
 * to that image and its language server. Unmapped languages have no sandbox
 * (their tests fall back to coding-questions' local runner with a notice).
 */

export const CODE_IMAGES = ["node", "python", "dotnet", "java", "go", "rust", "cpp"] as const;
export type CodeImage = (typeof CODE_IMAGES)[number];

export interface LspSpec {
	/** For the status line ("Python language server"). */
	name: string;
	/** Shell command that becomes the server (stdio), run in LSP_ROOT. */
	command: string;
	/** Shell run once in LSP_ROOT after the files land, before the start. */
	setup?: string;
	/** Config files written beside the learner's file (never shown). */
	config: { path: string; content: string }[];
	languageId: string;
	initializationOptions?: unknown;
	settings?: Record<string, unknown>;
	initializeTimeoutMs?: number;
}

export interface LanguageSpec {
	id: string;
	label: string;
	image: CodeImage;
	/** The file the learner's code is checked as (language servers need a name). */
	fileName(code: string): string;
	lsp: LspSpec;
}

/** The directory the language server works in (beside /work/run). */
export const LSP_ROOT = "/work/lsp";

const TS_BIN = "/opt/lsp/node_modules/.bin/typescript-language-server";
const TS_INIT = { tsserver: { path: "/opt/lsp/node_modules/typescript/lib" } };
const tsconfig = (strict: boolean) => ({
	path: "tsconfig.json",
	content: JSON.stringify({
		compilerOptions: {
			target: "esnext", module: "nodenext", moduleResolution: "nodenext", noEmit: true, allowJs: true, checkJs: true, strict, skipLibCheck: true,
			...(strict ? { allowImportingTsExtensions: true, erasableSyntaxOnly: true, verbatimModuleSyntax: true } : {}),
			types: ["node"], typeRoots: ["/opt/lsp/node_modules/@types"],
		},
		include: ["**/*"],
	}, null, "\t"),
});
const JAVA_SETTINGS = {
	java: {
		project: { referencedLibraries: ["/opt/lh/junit.jar"] },
		configuration: { runtimes: [{ name: "JavaSE-21", path: "/opt/java/openjdk", default: true }] },
	},
};
const RUST_SETTINGS = { cargo: { targetDir: true }, checkOnSave: true, check: { command: "check", allTargets: true } };

/** A public top-level Java class must live in its own-named file. */
function javaFile(code: string): string {
	const match = /\bpublic\s+(?:final\s+|abstract\s+)*(?:class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/.exec(code);
	return `${match?.[1] ?? "Answer"}.java`;
}

const SPECS: LanguageSpec[] = [
	{ id: "javascript", label: "JavaScript", image: "node", fileName: () => "answer.js",
		lsp: { name: "JavaScript", command: `${TS_BIN} --stdio`, config: [tsconfig(false)], languageId: "javascript", initializationOptions: TS_INIT } },
	{ id: "typescript", label: "TypeScript", image: "node", fileName: () => "answer.ts",
		lsp: { name: "TypeScript", command: `${TS_BIN} --stdio`, config: [tsconfig(true)], languageId: "typescript", initializationOptions: TS_INIT } },
	{ id: "python", label: "Python", image: "python", fileName: () => "answer.py",
		lsp: { name: "Python", command: "basedpyright-langserver --stdio", config: [{ path: "pyrightconfig.json", content: '{ "typeCheckingMode": "standard" }\n' }], languageId: "python",
			settings: { basedpyright: { analysis: { typeCheckingMode: "standard" } } } } },
	{ id: "csharp", label: "C#", image: "dotnet", fileName: () => "Answer.cs",
		lsp: { name: "C#", setup: "dotnet restore -nologo -v q >/dev/null 2>&1 || true", command: "/opt/lsp/csharp-ls", config: [], languageId: "csharp", initializeTimeoutMs: 180_000 } },
	{ id: "java", label: "Java", image: "java", fileName: javaFile,
		lsp: { name: "Java", setup: "mkdir -p /work/.jdtls/config && cp -r /opt/jdtls/config_linux/. /work/.jdtls/config/",
			command: "exec /opt/jre25/bin/java -Declipse.application=org.eclipse.jdt.ls.core.id1 -Dosgi.bundles.defaultStartLevel=4 " +
				"-Declipse.product=org.eclipse.jdt.ls.core.product -Dlog.level=ERROR -Xmx768m -XX:+UseSerialGC " +
				"--add-modules=ALL-SYSTEM --add-opens java.base/java.util=ALL-UNNAMED --add-opens java.base/java.lang=ALL-UNNAMED " +
				"-jar $(ls /opt/jdtls/plugins/org.eclipse.equinox.launcher_*.jar) -configuration /work/.jdtls/config -data /work/.jdtls/data",
			config: [], languageId: "java", initializationOptions: { settings: JAVA_SETTINGS }, settings: JAVA_SETTINGS, initializeTimeoutMs: 180_000 } },
	{ id: "go", label: "Go", image: "go", fileName: () => "answer.go",
		lsp: { name: "Go", command: "gopls", config: [], languageId: "go" } },
	{ id: "rust", label: "Rust", image: "rust", fileName: () => "src/lib.rs",
		lsp: { name: "Rust", command: "rust-analyzer", config: [], languageId: "rust", initializationOptions: RUST_SETTINGS, settings: { "rust-analyzer": RUST_SETTINGS } } },
	{ id: "cpp", label: "C++", image: "cpp", fileName: () => "answer.cpp",
		lsp: { name: "C++", command: "clangd --log=error --background-index=false", config: [{ path: "compile_flags.txt", content: "-std=c++20\n-I/opt/lh/include\n-xc++\n" }], languageId: "cpp" } },
	{ id: "c", label: "C", image: "cpp", fileName: () => "answer.c",
		lsp: { name: "C", command: "clangd --log=error --background-index=false", config: [{ path: "compile_flags.txt", content: "-std=c17\n-xc\n" }], languageId: "c" } },
];

const ALIASES: Record<string, string> = {
	js: "javascript", javascript: "javascript", node: "javascript", nodejs: "javascript", mjs: "javascript",
	ts: "typescript", typescript: "typescript",
	py: "python", python: "python", python3: "python",
	cs: "csharp", "c#": "csharp", csharp: "csharp", dotnet: "csharp",
	java: "java",
	go: "go", golang: "go",
	rs: "rust", rust: "rust",
	cpp: "cpp", "c++": "cpp", cxx: "cpp", cc: "cpp",
	c: "c",
};

/** The spec for a coding-questions language name, or null (no sandbox). */
export function languageSpec(language: string): LanguageSpec | null {
	const id = ALIASES[language.trim().toLowerCase()];
	return SPECS.find(spec => spec.id === id) ?? null;
}

/** For prompt text: the sandbox images and the tools each provides. */
export const SANDBOX_TOOLS: Record<CodeImage, string> = {
	node: "node 24 (JavaScript; TypeScript by type stripping), npm without network",
	python: "python3 3.13 with pytest",
	dotnet: ".NET 9 SDK (dotnet) with xUnit restored offline",
	java: "Java 21 (javac, java) with the JUnit 5 console jar at /opt/lh/junit.jar",
	go: "Go 1.24 (go)",
	rust: "Rust stable (cargo, rustc), offline",
	cpp: "g++ 14 / gcc with doctest at /opt/lh/include/doctest.h",
};
