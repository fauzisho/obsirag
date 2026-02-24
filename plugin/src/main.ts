import { Plugin, WorkspaceLeaf } from "obsidian";
import { DEFAULT_SETTINGS, RagSettings, RagSettingTab } from "./settings";
import { BackendManager } from "./backend-manager";
import { RagClient } from "./rag-client";
import { CHAT_VIEW_TYPE, ChatView } from "./views/chat-view";
import { registerIndexCommands } from "./commands";

export default class ObsiRagPlugin extends Plugin {
    settings!: RagSettings;
    ragClient!: RagClient;
    backendManager!: BackendManager;

    async onload(): Promise<void> {
        await this.loadSettings();

        this.ragClient = new RagClient(`http://127.0.0.1:${this.settings.backendPort}`);

        this.backendManager = new BackendManager(
            this.app,
            this.settings,
            this.ragClient,
            (this.app.vault.adapter as any).basePath as string
        );

        // Register the sidebar chat view
        this.registerView(CHAT_VIEW_TYPE, (leaf) => new ChatView(leaf, this));

        // Ribbon icon
        this.addRibbonIcon("message-circle", "Open RAG Chat", () => {
            this.activateChatView();
        });

        // Settings tab
        this.addSettingTab(new RagSettingTab(this.app, this));

        // Commands (index files, clear index)
        registerIndexCommands(this);

        // Start the backend once Obsidian's workspace is ready
        this.app.workspace.onLayoutReady(() => {
            this.backendManager.start();
        });
    }

    async onunload(): Promise<void> {
        await this.backendManager.stop();
    }

    async activateChatView(): Promise<void> {
        const { workspace } = this.app;
        const existing = workspace.getLeavesOfType(CHAT_VIEW_TYPE);

        if (existing.length > 0) {
            workspace.revealLeaf(existing[0]);
            return;
        }

        const leaf = workspace.getRightLeaf(false);
        if (leaf) {
            await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
            workspace.revealLeaf(leaf);
        }
    }

    async loadSettings(): Promise<void> {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }
}
