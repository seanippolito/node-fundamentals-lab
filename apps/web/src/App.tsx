import React from "react";
import CpuMemoryLab from "./components/CpuMemoryLab";
import {RealtimeLab} from "./components/RealtimeLab";
import Tabs from "./components/Tabs";

export default function App() {
    const tabs = [
        { label: "CPU & Memory Lab", content: <CpuMemoryLab /> },
        { label: "Realtime Lab", content: <RealtimeLab /> },
    ];

    return (
        <div className="container">
            <h1>Node Fundamentals Lab</h1>
            <Tabs tabs={tabs}/>
        </div>
    );
}
