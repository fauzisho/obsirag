import { ItemView, WorkspaceLeaf } from "obsidian";
import type ObsiRagPlugin from "../main";

export const GRAPH_VIEW_TYPE = "obsirag-graph";

const ENTITY_COLORS: Record<string, string> = {
    PERSON:       "#4A90D9",
    ORGANIZATION: "#E85D75",
    LOCATION:     "#50C878",
    CONCEPT:      "#FFB347",
    EVENT:        "#9B59B6",
    PRODUCT:      "#FF6B6B",
    TECHNOLOGY:   "#1ABC9C",
    CATEGORY:     "#F39C12",
    UNKNOWN:      "#7f8c8d",
};

function entityColor(type: string): string {
    return ENTITY_COLORS[type] ?? ENTITY_COLORS.UNKNOWN;
}

interface GNode {
    id: string;
    label: string;
    type: string;
    description: string;
    x: number;
    y: number;
    vx: number;
    vy: number;
    pinned: boolean;
    degree: number;
}

interface GEdge {
    source: string;
    target: string;
    label: string;
    weight: number;
}

export class GraphView extends ItemView {
    private plugin: ObsiRagPlugin;

    // Graph data
    private nodes: GNode[] = [];
    private edges: GEdge[] = [];
    private nodeMap = new Map<string, GNode>();

    // Canvas
    private canvas!: HTMLCanvasElement;
    private ctx!: CanvasRenderingContext2D;
    private animFrame: number | null = null;
    private isSimulating = false;

    // Interaction state
    private zoom = 1;
    private panX = 0;
    private panY = 0;
    private dragNode: GNode | null = null;
    private isPanning = false;
    private lastMouse = { x: 0, y: 0 };
    private selectedNode: GNode | null = null;

    // UI
    private statsEl!: HTMLElement;
    private infoEl!: HTMLElement;

    constructor(leaf: WorkspaceLeaf, plugin: ObsiRagPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType() { return GRAPH_VIEW_TYPE; }
    getDisplayText() { return "RAG Graph"; }
    getIcon() { return "git-fork"; }

    async onOpen(): Promise<void> {
        const root = this.containerEl.children[1] as HTMLElement;
        root.empty();
        root.addClass("rag-graph-root");

        // ── Toolbar ─────────────────────────────────────────────────────────
        const toolbar = root.createDiv({ cls: "rag-graph-toolbar" });

        this.statsEl = toolbar.createEl("span", { cls: "rag-graph-stats", text: "No data yet" });

        const refreshBtn = toolbar.createEl("button", { text: "↻ Refresh", cls: "rag-graph-btn" });
        refreshBtn.addEventListener("click", () => this.loadGraph());

        const resetBtn = toolbar.createEl("button", { text: "⊙ Reset view", cls: "rag-graph-btn" });
        resetBtn.addEventListener("click", () => { this.panX = 0; this.panY = 0; this.zoom = 1; this.draw(); });

        // Legend
        const legend = toolbar.createDiv({ cls: "rag-graph-legend" });
        for (const [type, color] of Object.entries(ENTITY_COLORS)) {
            if (type === "UNKNOWN") continue;
            const item = legend.createEl("span", { cls: "rag-graph-legend-item" });
            const dot = item.createEl("span", { cls: "rag-graph-legend-dot" });
            dot.style.backgroundColor = color;
            item.createEl("span", { text: type });
        }

        // ── Body: canvas + info panel ────────────────────────────────────────
        const body = root.createDiv({ cls: "rag-graph-body" });

        this.canvas = body.createEl("canvas", { cls: "rag-graph-canvas" });
        this.ctx = this.canvas.getContext("2d")!;

        this.infoEl = body.createDiv({ cls: "rag-graph-info" });
        this.infoEl.createEl("p", { text: "Click a node to see details", cls: "rag-graph-info-hint" });

        this.setupEvents();

        const ro = new ResizeObserver(() => this.resizeCanvas());
        ro.observe(body);
        this.register(() => ro.disconnect());

        this.resizeCanvas();
        await this.loadGraph();
    }

    async onClose(): Promise<void> {
        if (this.animFrame !== null) {
            cancelAnimationFrame(this.animFrame);
            this.animFrame = null;
        }
    }

    // ── Data loading ──────────────────────────────────────────────────────────

    private async loadGraph(): Promise<void> {
        this.statsEl.setText("Loading…");
        try {
            const data = await this.plugin.ragClient.getGraph();

            if (data.nodes.length === 0) {
                this.statsEl.setText("No graph data — index some files first.");
                this.nodes = [];
                this.edges = [];
                this.nodeMap.clear();
                this.draw();
                return;
            }

            // Compute degree for sizing nodes
            const degree: Record<string, number> = {};
            for (const e of data.edges) {
                degree[e.source] = (degree[e.source] ?? 0) + 1;
                degree[e.target] = (degree[e.target] ?? 0) + 1;
            }

            const cx = this.canvas.width / 2;
            const cy = this.canvas.height / 2;
            const spread = Math.min(this.canvas.width, this.canvas.height) * 0.4;

            this.nodes = data.nodes.map((n: any) => ({
                ...n,
                degree: degree[n.id] ?? 0,
                x: cx + (Math.random() - 0.5) * spread,
                y: cy + (Math.random() - 0.5) * spread,
                vx: 0, vy: 0, pinned: false,
            }));
            this.edges = data.edges;
            this.nodeMap = new Map(this.nodes.map((n) => [n.id, n]));

            this.statsEl.setText(
                `${data.stats.entities} entities · ${data.stats.relations} relations`
            );

            this.panX = 0; this.panY = 0; this.zoom = 1;
            this.selectedNode = null;
            this.infoEl.empty();
            this.infoEl.createEl("p", { text: "Click a node to see details", cls: "rag-graph-info-hint" });

            this.isSimulating = true;
            this.startLoop();
        } catch {
            this.statsEl.setText("Failed to load — is the backend running?");
        }
    }

    // ── Simulation ────────────────────────────────────────────────────────────

    private startLoop(): void {
        if (this.animFrame !== null) cancelAnimationFrame(this.animFrame);
        const tick = () => {
            if (this.isSimulating) this.simulate();
            this.draw();
            this.animFrame = requestAnimationFrame(tick);
        };
        this.animFrame = requestAnimationFrame(tick);
    }

    private simulate(): void {
        const REPULSION  = 1200;
        const ATTRACTION = 0.04;
        const DAMPING    = 0.82;
        const CENTER     = 0.008;
        const cx = this.canvas.width  / 2;
        const cy = this.canvas.height / 2;

        // Center pull
        for (const n of this.nodes) {
            if (n.pinned) continue;
            n.vx += (cx - n.x) * CENTER;
            n.vy += (cy - n.y) * CENTER;
        }

        // Repulsion (O(n²) — capped at 300 nodes in backend)
        for (let i = 0; i < this.nodes.length; i++) {
            for (let j = i + 1; j < this.nodes.length; j++) {
                const a = this.nodes[i], b = this.nodes[j];
                const dx = b.x - a.x, dy = b.y - a.y;
                const dist = Math.sqrt(dx * dx + dy * dy) || 1;
                const f = REPULSION / (dist * dist);
                const fx = (dx / dist) * f, fy = (dy / dist) * f;
                if (!a.pinned) { a.vx -= fx; a.vy -= fy; }
                if (!b.pinned) { b.vx += fx; b.vy += fy; }
            }
        }

        // Edge attraction (spring)
        for (const e of this.edges) {
            const a = this.nodeMap.get(e.source), b = this.nodeMap.get(e.target);
            if (!a || !b) continue;
            const dx = b.x - a.x, dy = b.y - a.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            const f = (dist - 120) * ATTRACTION;
            const fx = (dx / dist) * f, fy = (dy / dist) * f;
            if (!a.pinned) { a.vx += fx; a.vy += fy; }
            if (!b.pinned) { b.vx -= fx; b.vy -= fy; }
        }

        // Integrate + damp
        let ke = 0;
        for (const n of this.nodes) {
            if (n.pinned) continue;
            n.vx *= DAMPING; n.vy *= DAMPING;
            n.x  += n.vx;   n.y  += n.vy;
            ke   += n.vx * n.vx + n.vy * n.vy;
        }
        if (ke < 0.08) this.isSimulating = false;
    }

    // ── Rendering ─────────────────────────────────────────────────────────────

    private draw(): void {
        const ctx = this.ctx;
        const w = this.canvas.width, h = this.canvas.height;

        // Background
        const isDark = document.body.hasClass("theme-dark");
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = isDark ? "#1e1e1e" : "#f5f5f5";
        ctx.fillRect(0, 0, w, h);

        ctx.save();
        ctx.translate(this.panX, this.panY);
        ctx.scale(this.zoom, this.zoom);

        const textColor   = isDark ? "#c8c8c8" : "#333";
        const edgeColor   = isDark ? "rgba(180,180,180,0.18)" : "rgba(80,80,80,0.18)";

        // Edges
        ctx.strokeStyle = edgeColor;
        for (const e of this.edges) {
            const a = this.nodeMap.get(e.source), b = this.nodeMap.get(e.target);
            if (!a || !b) continue;
            ctx.lineWidth = Math.min(1.5, e.weight * 0.8) / this.zoom;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
        }

        // Nodes
        for (const n of this.nodes) {
            const r      = Math.min(14, 5 + n.degree * 0.6);
            const color  = entityColor(n.type);
            const isSelected = n === this.selectedNode;

            ctx.beginPath();
            ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
            ctx.fillStyle = color;
            ctx.fill();

            if (isSelected) {
                ctx.strokeStyle = isDark ? "#fff" : "#222";
                ctx.lineWidth = 2 / this.zoom;
                ctx.stroke();
            }

            // Label — only when zoomed in enough
            if (this.zoom > 0.5) {
                const fs = Math.max(9, 11 / this.zoom);
                ctx.font = `${fs}px var(--font-text, sans-serif)`;
                ctx.textAlign = "center";
                ctx.fillStyle = textColor;
                const label = n.label.length > 22 ? n.label.slice(0, 20) + "…" : n.label;
                ctx.fillText(label, n.x, n.y + r + fs * 0.9);
            }
        }

        ctx.restore();
    }

    // ── Canvas events ─────────────────────────────────────────────────────────

    private setupEvents(): void {
        const c = this.canvas;

        c.addEventListener("mousedown", (e) => {
            const pos  = this.toWorld(e);
            const node = this.hitTest(pos.x, pos.y);
            if (node) {
                this.dragNode  = node;
                node.pinned    = true;
                this.isSimulating = true;
                if (this.animFrame === null) this.startLoop();
                this.selectedNode = node;
                this.renderInfo(node);
            } else {
                this.isPanning = true;
            }
            this.lastMouse = { x: e.clientX, y: e.clientY };
        });

        c.addEventListener("mousemove", (e) => {
            const dx = e.clientX - this.lastMouse.x;
            const dy = e.clientY - this.lastMouse.y;
            this.lastMouse = { x: e.clientX, y: e.clientY };

            if (this.dragNode) {
                this.dragNode.x += dx / this.zoom;
                this.dragNode.y += dy / this.zoom;
                this.dragNode.vx = 0; this.dragNode.vy = 0;
            } else if (this.isPanning) {
                this.panX += dx; this.panY += dy;
            }
        });

        c.addEventListener("mouseup", () => {
            if (this.dragNode) { this.dragNode.pinned = false; this.dragNode = null; }
            this.isPanning = false;
        });

        c.addEventListener("mouseleave", () => {
            if (this.dragNode) { this.dragNode.pinned = false; this.dragNode = null; }
            this.isPanning = false;
        });

        c.addEventListener("wheel", (e) => {
            e.preventDefault();
            const factor = e.deltaY > 0 ? 0.9 : 1.1;
            const rect = c.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;
            this.panX = mx - (mx - this.panX) * factor;
            this.panY = my - (my - this.panY) * factor;
            this.zoom = Math.max(0.1, Math.min(6, this.zoom * factor));
            if (this.animFrame === null) this.draw();
        }, { passive: false });
    }

    private toWorld(e: MouseEvent): { x: number; y: number } {
        const rect = this.canvas.getBoundingClientRect();
        return {
            x: (e.clientX - rect.left - this.panX) / this.zoom,
            y: (e.clientY - rect.top  - this.panY) / this.zoom,
        };
    }

    private hitTest(x: number, y: number): GNode | null {
        const hitR = 14;
        for (let i = this.nodes.length - 1; i >= 0; i--) {
            const n = this.nodes[i];
            if ((n.x - x) ** 2 + (n.y - y) ** 2 < hitR ** 2) return n;
        }
        return null;
    }

    // ── Info panel ────────────────────────────────────────────────────────────

    private renderInfo(node: GNode): void {
        const el = this.infoEl;
        el.empty();

        const badge = el.createEl("span", { text: node.type, cls: "rag-graph-type-badge" });
        badge.style.backgroundColor = entityColor(node.type);

        el.createEl("h3", { text: node.label, cls: "rag-graph-info-name" });

        if (node.description) {
            el.createEl("p", { text: node.description, cls: "rag-graph-info-desc" });
        }

        el.createEl("p", {
            text: `${node.degree} connection${node.degree !== 1 ? "s" : ""}`,
            cls: "rag-graph-info-meta",
        });

        // Show connected nodes
        const neighbors = this.edges
            .filter((e) => e.source === node.id || e.target === node.id)
            .map((e) => {
                const peerId = e.source === node.id ? e.target : e.source;
                return { peer: this.nodeMap.get(peerId), label: e.label };
            })
            .filter((x) => x.peer)
            .slice(0, 8);

        if (neighbors.length > 0) {
            el.createEl("p", { text: "Connected to:", cls: "rag-graph-info-section" });
            const list = el.createEl("ul", { cls: "rag-graph-info-list" });
            for (const { peer, label } of neighbors) {
                const li = list.createEl("li");
                const dot = li.createEl("span", { cls: "rag-graph-info-dot" });
                dot.style.backgroundColor = entityColor(peer!.type);
                li.createEl("span", { text: peer!.label });
                if (label) li.createEl("span", { text: ` — ${label}`, cls: "rag-graph-info-rel" });
            }
        }
    }

    // ── Resize ────────────────────────────────────────────────────────────────

    private resizeCanvas(): void {
        const parent = this.canvas.parentElement!;
        const rect = parent.getBoundingClientRect();
        const infoW = 220;
        this.canvas.width  = Math.max(100, rect.width - infoW);
        this.canvas.height = Math.max(100, rect.height);
        this.draw();
    }
}
