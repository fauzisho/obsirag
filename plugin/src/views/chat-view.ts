import { ItemView, MarkdownRenderer, WorkspaceLeaf } from "obsidian";
import type ObsiRagPlugin from "../main";

export const CHAT_VIEW_TYPE = "obsirag-chat";

interface Message {
    role: "user" | "assistant";
    content: string;
}

export class ChatView extends ItemView {
    private plugin: ObsiRagPlugin;
    private messagesEl!: HTMLElement;
    private inputEl!: HTMLTextAreaElement;
    private sendBtn!: HTMLButtonElement;
    private messages: Message[] = [];

    constructor(leaf: WorkspaceLeaf, plugin: ObsiRagPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType(): string { return CHAT_VIEW_TYPE; }
    getDisplayText(): string { return "RAG Chat"; }
    getIcon(): string { return "message-circle"; }

    async onOpen(): Promise<void> {
        const root = this.containerEl.children[1] as HTMLElement;
        root.empty();
        root.addClass("rag-chat-root");

        // ── Messages area ─────────────────────────────────────────────────
        this.messagesEl = root.createDiv({ cls: "rag-messages" });

        // ── Input row ─────────────────────────────────────────────────────
        const inputRow = root.createDiv({ cls: "rag-input-row" });

        this.inputEl = inputRow.createEl("textarea", {
            cls: "rag-input",
            attr: { placeholder: "Ask anything about your vault… (Enter to send, Shift+Enter for newline)" },
        });
        this.inputEl.rows = 3;

        this.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                this.send();
            }
        });

        const controlRow = root.createDiv({ cls: "rag-control-row" });

        // Mode selector
        const modeSelect = controlRow.createEl("select", { cls: "rag-mode-select" });
        (["hybrid", "local", "global", "naive"] as const).forEach((m) => {
            const opt = modeSelect.createEl("option", { text: m, value: m });
            if (m === this.plugin.settings.queryMode) opt.selected = true;
        });
        modeSelect.addEventListener("change", () => {
            this.plugin.settings.queryMode = modeSelect.value as any;
            this.plugin.saveSettings();
        });

        // Clear chat button
        const clearBtn = controlRow.createEl("button", { text: "Clear chat", cls: "rag-clear-btn" });
        clearBtn.addEventListener("click", () => {
            this.messages = [];
            this.messagesEl.empty();
        });

        // Send button
        this.sendBtn = controlRow.createEl("button", { text: "Send", cls: "rag-send-btn mod-cta" });
        this.sendBtn.addEventListener("click", () => this.send());
    }

    private async send(): Promise<void> {
        const text = this.inputEl.value.trim();
        if (!text) return;

        this.inputEl.value = "";
        this.appendMessage({ role: "user", content: text });

        this.sendBtn.disabled = true;
        this.sendBtn.setText("…");

        const thinkingEl = this.messagesEl.createDiv({ cls: "rag-message rag-assistant rag-thinking" });
        thinkingEl.setText("Thinking…");
        thinkingEl.scrollIntoView({ behavior: "smooth" });

        try {
            const result = await this.plugin.ragClient.query({
                question: text,
                mode: this.plugin.settings.queryMode,
            });
            thinkingEl.remove();
            this.appendMessage({ role: "assistant", content: result.answer });
        } catch (err) {
            thinkingEl.remove();
            const msg = err instanceof Error ? err.message : String(err);
            this.appendMessage({
                role: "assistant",
                content: `**Error:** ${msg}\n\nIs the RAG backend running?`,
            });
        } finally {
            this.sendBtn.disabled = false;
            this.sendBtn.setText("Send");
        }
    }

    private appendMessage(msg: Message): void {
        this.messages.push(msg);
        const el = this.messagesEl.createDiv({ cls: `rag-message rag-${msg.role}` });

        if (msg.role === "assistant") {
            MarkdownRenderer.render(this.app, msg.content, el, "", this);
        } else {
            el.createEl("p", { text: msg.content });
        }

        el.scrollIntoView({ behavior: "smooth" });
    }

    async onClose(): Promise<void> {}
}
