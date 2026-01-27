export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(path, init);
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
}
