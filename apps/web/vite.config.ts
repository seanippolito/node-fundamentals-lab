import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
    plugins: [react()],
    server: {
        proxy: {
            "/health": "http://localhost:4000",
            "/metrics": "http://localhost:4000",
            "/files": "http://localhost:4000",
            "/upload": "http://localhost:4000",
            "/labs": "http://localhost:4000",
            "/cpu": "http://localhost:4000"
        }
    }
});
