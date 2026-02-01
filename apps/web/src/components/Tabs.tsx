import React, { useState, ReactNode } from "react";

interface Tab {
    label: string;
    content: ReactNode;
}

interface TabsProps {
    tabs: Tab[];
}

export default function Tabs({ tabs }: TabsProps) {
    const [activeIndex, setActiveIndex] = useState(0);

    return (
        <div className="tabs">
            <div className="tabs-header">
                {tabs.map((tab, index) => (
                    <button
                        key={index}
                        className={`tab-button ${index === activeIndex ? "active" : ""}`}
                        onClick={() => setActiveIndex(index)}
                    >
                        {tab.label}
                    </button>
                ))}
            </div>
            <div className="tab-content">
                {tabs[activeIndex].content}
            </div>
        </div>
    );
}
