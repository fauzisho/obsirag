import { App, PluginSettingTab, Setting } from "obsidian";
import type ObsiRagPlugin from "./main";

export interface RagSettings {
    openaiApiKey: string;
    llmModel: string;
    backendPort: number;
    queryMode: "hybrid" | "local" | "global" | "naive";
    githubReleaseTag: string;
}

export const DEFAULT_SETTINGS: RagSettings = {
    openaiApiKey: "",
    llmModel: "gpt-4o-mini",
    backendPort: 8765,
    queryMode: "hybrid",
    githubReleaseTag: "v0.1.0",
};

export class RagSettingTab extends PluginSettingTab {
    plugin: ObsiRagPlugin;

    constructor(app: App, plugin: ObsiRagPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl("h2", { text: "ObsiRAG" });

        // ── OpenAI ────────────────────────────────────────────────────────
        new Setting(containerEl)
            .setName("OpenAI API Key")
            .setDesc("Stored in plain text in your vault's data.json. Keep your vault private.")
            .addText((text) => {
                text.inputEl.type = "password";
                text.setPlaceholder("sk-...")
                    .setValue(this.plugin.settings.openaiApiKey)
                    .onChange(async (value) => {
                        this.plugin.settings.openaiApiKey = value.trim();
                        await this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName("Model")
            .setDesc("OpenAI model for answering queries. Embeddings always use text-embedding-3-small.")
            .addDropdown((drop) =>
                drop
                    .addOption("gpt-4o-mini", "gpt-4o-mini (fast, cheap)")
                    .addOption("gpt-4o", "gpt-4o (best quality)")
                    .addOption("gpt-4.1-mini", "gpt-4.1-mini")
                    .setValue(this.plugin.settings.llmModel)
                    .onChange(async (value) => {
                        this.plugin.settings.llmModel = value;
                        await this.plugin.saveSettings();
                    })
            );

        // ── Retrieval ─────────────────────────────────────────────────────
        containerEl.createEl("h3", { text: "Retrieval" });

        new Setting(containerEl)
            .setName("Query mode")
            .setDesc(
                "hybrid = best for most queries  |  local = entity-focused  |  global = theme-focused  |  naive = simple vector search"
            )
            .addDropdown((drop) =>
                drop
                    .addOption("hybrid", "Hybrid (recommended)")
                    .addOption("local", "Local")
                    .addOption("global", "Global")
                    .addOption("naive", "Naive")
                    .setValue(this.plugin.settings.queryMode)
                    .onChange(async (value: RagSettings["queryMode"]) => {
                        this.plugin.settings.queryMode = value;
                        await this.plugin.saveSettings();
                    })
            );

        // ── Advanced ──────────────────────────────────────────────────────
        containerEl.createEl("h3", { text: "Advanced" });

        new Setting(containerEl)
            .setName("Backend port")
            .setDesc("Port for the local RAG server. Change only if 8765 is taken.")
            .addText((text) =>
                text
                    .setValue(String(this.plugin.settings.backendPort))
                    .onChange(async (value) => {
                        const port = parseInt(value);
                        if (!isNaN(port) && port > 1024 && port < 65536) {
                            this.plugin.settings.backendPort = port;
                            await this.plugin.saveSettings();
                        }
                    })
            );

        new Setting(containerEl)
            .setName("GitHub release tag")
            .setDesc("Backend binary release to download (e.g. v0.1.0)")
            .addText((text) =>
                text
                    .setValue(this.plugin.settings.githubReleaseTag)
                    .onChange(async (value) => {
                        this.plugin.settings.githubReleaseTag = value.trim();
                        await this.plugin.saveSettings();
                    })
            );
    }
}
