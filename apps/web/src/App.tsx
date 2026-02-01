import React from "react";
import CpuMemoryLab from "./components/CpuMemoryLab";
import {RealtimeLab} from "./components/RealtimeLab";

export default function App() {

    return (
        <div className="container">
            <CpuMemoryLab/>
            <RealtimeLab/>
        </div>
    );
}
