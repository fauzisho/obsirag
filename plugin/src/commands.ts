import { Notice, TFile } from "obsidian";
import type ObsiRagPlugin from "./main";

const INDEXABLE_EXTS = new Set(["md", "pdf", "docx", "doc", "xlsx", "xls", "png", "jpg", "jpeg", "tiff", "tif", "bmp", "webp", "txt"]);

export function registerIndexCommands(plugin: ObsiRagPlugin): void {
    // Index the current active file
    plugin.addCommand({
        id: "index-current-file",
        name: "Index current file",
        checkCallback: (checking) => {
            const file = plugin.app.workspace.getActiveFile();
            if (!file || !INDEXABLE_EXTS.has(file.extension.toLowerCase())) return false;
            if (!checking) indexFiles(plugin, [file]);
            return true;
        },
    });

    // Index the entire vault
    plugin.addCommand({
        id: "index-vault",
        name: "Index entire vault",
        callback: () => {
            const files = plugin.app.vault
                .getFiles()
                .filter((f) => INDEXABLE_EXTS.has(f.extension.toLowerCase()));
            indexFiles(plugin, files);
        },
    });

    // Index the folder of the current active file
    plugin.addCommand({
        id: "index-current-folder",
        name: "Index current folder",
        checkCallback: (checking) => {
            const file = plugin.app.workspace.getActiveFile();
            if (!file?.parent) return false;
            if (!checking) {
                const folderPath = file.parent.path;
                const files = plugin.app.vault
                    .getFiles()
                    .filter(
                        (f) =>
                            f.path.startsWith(folderPath) &&
                            INDEXABLE_EXTS.has(f.extension.toLowerCase())
                    );
                indexFiles(plugin, files);
            }
            return true;
        },
    });

    // Clear the entire RAG index
    plugin.addCommand({
        id: "clear-index",
        name: "Clear RAG index",
        callback: async () => {
            try {
                await plugin.ragClient.clearIndex();
                new Notice("RAG: index cleared.");
            } catch {
                new Notice("RAG: failed to clear index. Is the backend running?");
            }
        },
    });
}

async function indexFiles(plugin: ObsiRagPlugin, files: TFile[]): Promise<void> {
    if (files.length === 0) {
        new Notice("RAG: no indexable files found.");
        return;
    }

    // Get absolute disk paths (vault adapter exposes basePath on desktop)
    const vaultPath = (plugin.app.vault.adapter as any).basePath as string;
    const absolutePaths = files.map((f) => `${vaultPath}/${f.path}`);

    new Notice(`RAG: indexing ${files.length} file(s)…`);

    try {
        await plugin.ragClient.indexDocuments({
            paths: absolutePaths,
            vault_path: vaultPath,
        });
    } catch {
        new Notice("RAG: failed to start indexing. Is the backend running?");
        return;
    }

    // Poll status and update the status bar
    const statusItem = plugin.addStatusBarItem();

    const poll = setInterval(async () => {
        try {
            const status = await plugin.ragClient.getIndexStatus();
            statusItem.setText(`RAG: ${status.indexed}/${status.total}`);

            if (!status.running) {
                clearInterval(poll);
                statusItem.remove();
                const errCount = status.errors.length;
                if (errCount > 0) {
                    new Notice(
                        `RAG: indexed ${status.indexed}/${status.total} files (${errCount} error(s) — see console).`
                    );
                    status.errors.forEach((e) =>
                        console.error(`[RAG] indexing error for ${e.file}: ${e.error}`)
                    );
                } else {
                    new Notice(`RAG: indexed ${status.indexed} file(s) successfully.`);
                }
            }
        } catch {
            clearInterval(poll);
            statusItem.remove();
        }
    }, 2000);
}
