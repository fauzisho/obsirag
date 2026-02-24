import { App, Modal, Notice } from "obsidian";
import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as net from "net";
import type { RagSettings } from "./settings";
import type { RagClient } from "./rag-client";

const GITHUB_OWNER = "fauzisho";
const GITHUB_REPO = "obsirag";

function getPlatformBinaryName(): string {
    if (process.platform === "darwin") return "obsirag-backend-macos";
    if (process.platform === "win32") return "obsirag-backend-windows.exe";
    return "obsirag-backend-linux";
}

function isPortInUse(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.once("error", () => resolve(true));
        server.once("listening", () => {
            server.close();
            resolve(false);
        });
        server.listen(port, "127.0.0.1");
    });
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export class BackendManager {
    private process: ChildProcess | null = null;
    private restartAttempts = 0;
    private readonly maxRestarts = 3;
    private healthCheckInterval: ReturnType<typeof setInterval> | null = null;

    constructor(
        private app: App,
        private settings: RagSettings,
        private ragClient: RagClient,
        private vaultPath: string
    ) {}

    get binDir(): string {
        return path.join(this.vaultPath, ".obsirag", "bin");
    }

    get binaryPath(): string {
        return path.join(this.binDir, getPlatformBinaryName());
    }

    async start(): Promise<void> {
        // 1. Ensure binary exists
        if (!fs.existsSync(this.binaryPath)) {
            const downloaded = await this.promptDownload();
            if (!downloaded) {
                new Notice("RAG: backend binary not found. Chat is disabled.");
                return;
            }
        }

        // 2. Check if port is already occupied
        const portBusy = await isPortInUse(this.settings.backendPort);
        if (portBusy) {
            const healthy = await this.ragClient.healthCheck();
            if (healthy) {
                new Notice("RAG: backend already running.");
                this.startHealthMonitor();
                return;
            }
            new Notice(
                `RAG: port ${this.settings.backendPort} is in use by another process. Change the port in settings.`
            );
            return;
        }

        // 3. Spawn
        this.spawnBackend();
    }

    private buildCliArgs(): string[] {
        const s = this.settings;
        return [
            "--vault-path", this.vaultPath,
            "--openai-key", s.openaiApiKey,
            "--llm-model", s.llmModel,
            "--port", String(s.backendPort),
        ];
    }

    private spawnBackend(): void {
        const args = this.buildCliArgs();
        const storageDir = path.join(this.vaultPath, ".obsirag");

        this.process = spawn(this.binaryPath, args, {
            cwd: storageDir,
            stdio: ["ignore", "pipe", "pipe"],
            detached: false,
        });

        this.process.stdout?.on("data", (data: Buffer) => {
            console.log(`[RAG Backend] ${data.toString().trim()}`);
        });

        this.process.stderr?.on("data", (data: Buffer) => {
            console.error(`[RAG Backend ERR] ${data.toString().trim()}`);
        });

        this.process.on("exit", (code, signal) => {
            console.log(`[RAG Backend] exited code=${code} signal=${signal}`);
            this.process = null;
            this.stopHealthMonitor();

            if (this.restartAttempts < this.maxRestarts && code !== 0 && code !== null) {
                this.restartAttempts++;
                new Notice(`RAG: backend crashed. Restarting (${this.restartAttempts}/${this.maxRestarts})…`);
                setTimeout(() => this.spawnBackend(), 3000);
            } else if (this.restartAttempts >= this.maxRestarts) {
                new Notice("RAG: backend failed to start after 3 attempts. Check console for errors.");
            }
        });

        this.waitForHealthy(20000).then((ok) => {
            if (ok) {
                new Notice("RAG: backend ready.");
                this.restartAttempts = 0;
                this.startHealthMonitor();
            } else {
                new Notice("RAG: backend did not respond within 20s. Check console.");
            }
        });
    }

    private async waitForHealthy(timeoutMs: number): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (await this.ragClient.healthCheck()) return true;
            await sleep(500);
        }
        return false;
    }

    private startHealthMonitor(): void {
        this.healthCheckInterval = setInterval(async () => {
            const ok = await this.ragClient.healthCheck();
            if (!ok) {
                console.warn("[RAG Backend] health check failed");
                this.stopHealthMonitor();
            }
        }, 30_000);
    }

    private stopHealthMonitor(): void {
        if (this.healthCheckInterval !== null) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = null;
        }
    }

    async stop(): Promise<void> {
        this.stopHealthMonitor();
        if (this.process) {
            this.process.kill("SIGTERM");
            await sleep(3000);
            if (this.process && !this.process.killed) {
                this.process.kill("SIGKILL");
            }
            this.process = null;
        }
    }

    private promptDownload(): Promise<boolean> {
        return new Promise((resolve) => {
            new DownloadModal(this.app, this.settings, this.binDir, resolve).open();
        });
    }
}

// ── Download Modal ──────────────────────────────────────────────────────────

class DownloadModal extends Modal {
    private progressEl!: HTMLProgressElement;
    private statusEl!: HTMLElement;

    constructor(
        app: App,
        private settings: RagSettings,
        private binDir: string,
        private onComplete: (success: boolean) => void
    ) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.createEl("h2", { text: "Download RAG Backend" });
        contentEl.createEl("p", {
            text: "The RAG backend binary needs to be downloaded once (~80-150 MB). It will be stored inside your vault.",
        });

        this.statusEl = contentEl.createEl("p", { text: "Preparing…" });

        const prog = contentEl.createEl("progress") as HTMLProgressElement;
        prog.max = 100;
        prog.value = 0;
        prog.style.width = "100%";
        prog.style.marginTop = "8px";
        this.progressEl = prog;

        this.download();
    }

    private async download(): Promise<void> {
        const binaryName = getPlatformBinaryName();
        const tag = this.settings.githubReleaseTag;
        const base = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/${tag}`;
        const downloadUrl = `${base}/${binaryName}`;
        const checksumUrl = `${downloadUrl}.sha256`;

        try {
            // Step 1 — fetch expected SHA-256
            this.statusEl.setText("Fetching checksum…");
            const { requestUrl } = await import("obsidian");
            const csResp = await requestUrl({ url: checksumUrl });
            const expectedHash = csResp.text.trim().split(/\s+/)[0].toLowerCase();

            // Step 2 — stream binary for progress reporting
            this.statusEl.setText("Downloading binary…");
            const response = await fetch(downloadUrl);
            if (!response.ok) throw new Error(`HTTP ${response.status} from ${downloadUrl}`);

            const contentLength = parseInt(response.headers.get("content-length") ?? "0");
            const reader = response.body!.getReader();
            const chunks: Uint8Array[] = [];
            let received = 0;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                received += value.length;
                if (contentLength > 0) {
                    this.progressEl.value = Math.round((received / contentLength) * 100);
                }
            }

            // Step 3 — verify checksum
            this.statusEl.setText("Verifying checksum…");
            const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
            const buffer = new Uint8Array(totalLen);
            let offset = 0;
            for (const chunk of chunks) {
                buffer.set(chunk, offset);
                offset += chunk.length;
            }

            const hashBuf = await crypto.subtle.digest("SHA-256", buffer);
            const actualHash = Array.from(new Uint8Array(hashBuf))
                .map((b) => b.toString(16).padStart(2, "0"))
                .join("");

            if (actualHash !== expectedHash) {
                throw new Error(`Checksum mismatch.\nExpected: ${expectedHash}\nGot:      ${actualHash}`);
            }

            // Step 4 — write to disk
            this.statusEl.setText("Installing…");
            fs.mkdirSync(this.binDir, { recursive: true });
            const filePath = path.join(this.binDir, binaryName);
            fs.writeFileSync(filePath, buffer);

            if (process.platform !== "win32") {
                fs.chmodSync(filePath, 0o755);
            }

            // macOS: remove Gatekeeper quarantine attribute automatically
            if (process.platform === "darwin") {
                try {
                    const { execSync } = await import("child_process");
                    execSync(`xattr -d com.apple.quarantine "${filePath}"`, { stdio: "ignore" });
                } catch {
                    // Attribute may not exist; ignore
                }
            }

            this.statusEl.setText("Download complete.");
            this.progressEl.value = 100;

            setTimeout(() => {
                this.close();
                this.onComplete(true);
            }, 800);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.statusEl.setText(`Download failed: ${msg}`);

            const btnRow = this.contentEl.createDiv({ cls: "modal-button-container" });

            const retryBtn = btnRow.createEl("button", { text: "Retry" });
            retryBtn.onclick = () => {
                btnRow.remove();
                this.download();
            };

            const skipBtn = btnRow.createEl("button", { text: "Skip" });
            skipBtn.onclick = () => {
                this.close();
                this.onComplete(false);
            };
        }
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
