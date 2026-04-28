import { useEffect, useState } from "react";
import { useChatStore } from "./stores/chatStore.js";
import { useSettingsStore } from "./stores/settingsStore.js";
import { TABS } from "./constants/config.js";
import ChatView from "./components/chat/ChatView.jsx";
import ConversationHistory from "./components/history/ConversationHistory.jsx";
import ModelManager from "./components/models/ModelManager.jsx";
import SystemStats from "./components/stats/SystemStats.jsx";
import SettingsPanel from "./components/settings/SettingsPanel.jsx";
import "./App.css";

export default function App() {
  const [activeTab, setActiveTab] = useState("chat");
  const { loadConversations } = useChatStore();
  const { loadSettings } = useSettingsStore();

  useEffect(() => {
    loadSettings();
    loadConversations();
  }, [loadSettings, loadConversations]);

  const renderContent = () => {
    switch (activeTab) {
      case "chat":
        return <ChatView />;
      case "models":
        return <ModelManager />;
      case "stats":
        return <SystemStats />;
      case "settings":
        return <SettingsPanel />;
      default:
        return <ChatView />;
    }
  };

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-logo">
          <div className="app-logo-icon"></div>
          LLMUI
        </div>
        <nav className="app-tabs">
          {Object.values(TABS).map((tab) => (
            <button
              key={tab.key}
              className={`app-tab ${activeTab === tab.key ? "active" : ""}`}
              style={activeTab === tab.key ? { color: tab.color } : undefined}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="app-main">
        {activeTab === "chat" && (
          <aside className="app-sidebar">
            <ConversationHistory />
          </aside>
        )}
        <section className="app-content">{renderContent()}</section>
      </main>
    </div>
  );
}
