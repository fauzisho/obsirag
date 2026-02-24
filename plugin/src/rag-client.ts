import { requestUrl } from "obsidian";

export interface IndexRequest {
    paths: string[];
    vault_path: string;
}

export interface QueryRequest {
    question: string;
    mode: "hybrid" | "local" | "global" | "naive";
}

export interface IndexStatus {
    total: number;
    indexed: number;
    current_file: string;
    running: boolean;
    errors: Array<{ file: string; error: string }>;
}

export class RagClient {
    constructor(private baseUrl: string) {}

    async healthCheck(): Promise<boolean> {
        try {
            const resp = await requestUrl({
                url: `${this.baseUrl}/health`,
                method: "GET",
                throw: false,
            });
            return resp.status === 200;
        } catch {
            return false;
        }
    }

    async indexDocuments(req: IndexRequest): Promise<{ message: string; count: number }> {
        const resp = await requestUrl({
            url: `${this.baseUrl}/index`,
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(req),
            throw: true,
        });
        return resp.json;
    }

    async query(req: QueryRequest): Promise<{ answer: string; mode: string; sources?: string[] }> {
        const resp = await requestUrl({
            url: `${this.baseUrl}/query`,
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(req),
            throw: true,
        });
        return resp.json;
    }

    async reconnect(): Promise<void> {
        await requestUrl({
            url: `${this.baseUrl}/reconnect`,
            method: "POST",
            throw: true,
        });
    }

    async clearIndex(): Promise<void> {
        await requestUrl({
            url: `${this.baseUrl}/index`,
            method: "DELETE",
            throw: true,
        });
    }

    async getIndexStatus(): Promise<IndexStatus> {
        const resp = await requestUrl({
            url: `${this.baseUrl}/index/status`,
            method: "GET",
            throw: true,
        });
        return resp.json;
    }
}
