import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
    plugins: [react()],
    server: {
        proxy: {
            "/health": { target: "http://localhost:4000", changeOrigin: true },
            "/files": { target: "http://localhost:4000", changeOrigin: true },
            "/upload": { target: "http://localhost:4000", changeOrigin: true },
            "/metrics": { target: "http://localhost:4000", changeOrigin: true },
            "/labs": { target: "http://localhost:4000", changeOrigin: true },
            "/cpu": { target: "http://localhost:4000", changeOrigin: true },
            "/realtime": { target: "http://localhost:4000", changeOrigin: true, ws: true }
        }
    }
});
