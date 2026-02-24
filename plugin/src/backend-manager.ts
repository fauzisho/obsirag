import { App, Modal, Notice } from "obsidian";
import { spawn, exec, ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as net from "net";
import * as https from "https";
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
    private lastSeenAlive = 0;
    private focusHandler: (() => void) | null = null;

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
        // 1. Validate required settings before attempting spawn
        if (!this.settings.openaiApiKey) {
            new Notice("RAG: OpenAI API key is not set. Configure it in plugin settings.");
            return;
        }

        // 2. Ensure binary exists
        if (!fs.existsSync(this.binaryPath)) {
            const downloaded = await this.promptDownload();
            if (!downloaded) {
                new Notice("RAG: backend binary not found. Chat is disabled.");
                return;
            }
        }

        // 3. Brief grace period so the OS fully releases the port after a recent stop()
        await sleep(600);

        // 4. Check if port is already occupied (retry once to handle transient state)
        let portBusy = await isPortInUse(this.settings.backendPort);
        if (!portBusy) {
            // Double-check after another short wait — SIGKILL release can be non-instant
            await sleep(300);
            portBusy = await isPortInUse(this.settings.backendPort);
        }

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

        // 5. Spawn
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

        const startNotice = new Notice("RAG: backend starting…", 0); // 0 = persist until dismissed
        this.waitForHealthy(60000, this.process).then((ok) => {
            startNotice.hide();
            if (ok) {
                new Notice("RAG: backend ready.");
                this.restartAttempts = 0;
                this.startHealthMonitor();
            } else {
                new Notice("RAG: backend did not respond. Check console for errors.");
            }
        });
    }

    private async waitForHealthy(timeoutMs: number, spawnedProcess: ChildProcess | null): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (await this.ragClient.healthCheck()) return true;
            // Process exited before becoming healthy — abort immediately instead of
            // waiting out the full timeout. The exit handler will handle restart logic.
            if (this.process !== spawnedProcess) return false;
            await sleep(500);
        }
        return false;
    }

    private startHealthMonitor(): void {
        this.lastSeenAlive = Date.now();

        this.healthCheckInterval = setInterval(async () => {
            const ok = await this.ragClient.healthCheck();
            if (ok) {
                this.lastSeenAlive = Date.now();
            } else {
                console.warn("[RAG Backend] health check failed");
                this.stopHealthMonitor();
                // If we own the process, let the exit handler restart it.
                // If it's an external process (port was already busy), try reconnect.
                if (!this.process) {
                    await this.tryReconnect();
                }
            }
        }, 30_000);

        // Detect wake-from-sleep via window focus. macOS suspends processes
        // during sleep, so HTTP sessions inside the Python backend become stale.
        // Reconnect to refresh them when the user returns to Obsidian.
        this.focusHandler = async () => {
            const gapMs = Date.now() - this.lastSeenAlive;
            // Only reconnect if we've been away for more than 60 s (real sleep, not just focus loss)
            if (gapMs > 60_000) {
                console.log(`[RAG Backend] Wake detected (gap ${Math.round(gapMs / 1000)}s) — reconnecting engine…`);
                await this.tryReconnect();
            }
            this.lastSeenAlive = Date.now();
        };
        window.addEventListener("focus", this.focusHandler);
    }

    private stopHealthMonitor(): void {
        if (this.healthCheckInterval !== null) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = null;
        }
        if (this.focusHandler !== null) {
            window.removeEventListener("focus", this.focusHandler);
            this.focusHandler = null;
        }
    }

    async tryReconnect(): Promise<void> {
        // Try the fast /reconnect endpoint first (only available in newer binary builds).
        // Fall back to a full process restart if the endpoint doesn't exist.
        try {
            await this.ragClient.reconnect();
            new Notice("RAG: engine reconnected.");
            this.startHealthMonitor();
            return;
        } catch (e) {
            console.warn("[RAG Backend] /reconnect not available, falling back to full restart:", e);
        }

        new Notice("RAG: restarting backend…");
        this.stopHealthMonitor();

        // If we own the process, kill it gracefully. Otherwise kill whatever is on the port.
        if (this.process) {
            await this.stop();
        } else {
            await this.killPortOccupant(this.settings.backendPort);
        }

        await sleep(1500);
        this.restartAttempts = 0;
        this.spawnBackend();
    }

    private killPortOccupant(port: number): Promise<void> {
        return new Promise((resolve) => {
            const cmd = process.platform === "win32"
                ? `for /f "tokens=5" %a in ('netstat -aon ^| findstr :${port}') do taskkill /F /PID %a`
                : `lsof -ti tcp:${port} | xargs kill -9`;
            exec(cmd, () => resolve()); // ignore errors (process may already be gone)
        });
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
        } else {
            // Backend was adopted (started externally) — kill by port on disable
            const portBusy = await isPortInUse(this.settings.backendPort);
            if (portBusy) {
                await this.killPortOccupant(this.settings.backendPort);
            }
        }
    }

    private promptDownload(): Promise<boolean> {
        return new Promise((resolve) => {
            new DownloadModal(this.app, this.settings, this.binDir, resolve).open();
        });
    }
}

// ── HTTPS helpers (handle GitHub redirects, large files) ────────────────────

function httpsGet(url: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { "User-Agent": "obsirag-plugin" } }, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                httpsGet(res.headers.location!).then(resolve).catch(reject);
                return;
            }
            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode} for ${url}`));
                return;
            }
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => resolve(Buffer.concat(chunks)));
            res.on("error", reject);
        }).on("error", reject);
    });
}

function httpsDownload(
    url: string,
    dest: string,
    onProgress: (pct: number) => void
): Promise<void> {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { "User-Agent": "obsirag-plugin" } }, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                httpsDownload(res.headers.location!, dest, onProgress).then(resolve).catch(reject);
                return;
            }
            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode} for ${url}`));
                return;
            }
            const total = parseInt(res.headers["content-length"] ?? "0");
            let received = 0;
            const file = fs.createWriteStream(dest);
            res.on("data", (chunk: Buffer) => {
                received += chunk.length;
                if (total > 0) onProgress(Math.round((received / total) * 100));
            });
            res.pipe(file);
            file.on("finish", () => file.close(() => resolve()));
            file.on("error", reject);
            res.on("error", reject);
        }).on("error", reject);
    });
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
            // Step 1 — fetch expected SHA-256 via Node https
            this.statusEl.setText("Fetching checksum…");
            const expectedHash = await httpsGet(checksumUrl)
                .then((buf) => buf.toString("utf8").trim().split(/\s+/)[0].toLowerCase());

            // Step 2 — download binary via Node https (handles redirects, large files)
            this.statusEl.setText("Downloading binary (~60-75 MB)…");
            this.progressEl.removeAttribute("value");
            fs.mkdirSync(this.binDir, { recursive: true });
            const filePath = path.join(this.binDir, binaryName);
            await httpsDownload(downloadUrl, filePath, (pct) => {
                this.progressEl.value = pct;
                this.statusEl.setText(`Downloading… ${pct}%`);
            });

            const buffer = new Uint8Array(fs.readFileSync(filePath).buffer);

            // Step 3 — verify checksum
            this.statusEl.setText("Verifying checksum…");
            this.progressEl.value = 95;

            const hashBuf = await crypto.subtle.digest("SHA-256", buffer);
            const actualHash = Array.from(new Uint8Array(hashBuf))
                .map((b) => b.toString(16).padStart(2, "0"))
                .join("");

            if (actualHash !== expectedHash) {
                throw new Error(`Checksum mismatch.\nExpected: ${expectedHash}\nGot:      ${actualHash}`);
            }

            // Step 4 — set permissions
            this.statusEl.setText("Installing…");
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
