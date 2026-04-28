import { useEffect, useState } from "react";
import { useChatStore } from "./stores/chatStore.js";
import { useSettingsStore } from "./stores/settingsStore.js";
import { TABS } from "./constants/config.js";
import ChatView from "./components/chat/ChatView.jsx";
import ConversationHistory from "./components/history/ConversationHistory.jsx";
import ModelManager from "./components/models/ModelManager.jsx";
import SystemStats from "./components/stats/SystemStats.jsx";
import SettingsPanel from "./components/settings/SettingsPanel.jsx";

const appStyle = {
  display: "flex",
  flexDirection: "column",
  height: "100vh",
  maxWidth: "1400px",
  margin: "0 auto",
  padding: "20px",
};

const headerStyle = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: "20px",
};

const logoStyle = {
  fontSize: "24px",
  fontWeight: "700",
  color: "#e8e8f0",
  display: "flex",
  alignItems: "center",
  gap: "12px",
};

const logoIconStyle = {
  width: "32px",
  height: "32px",
  background: "linear-gradient(135deg, #6ee7b7, #60a5fa)",
  borderRadius: "8px",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: "18px",
};

const tabsStyle = {
  display: "flex",
  gap: "4px",
  background: "rgba(255,255,255,0.02)",
  borderRadius: "8px",
  padding: "4px",
};

const tabStyle = (isActive, color) => ({
  padding: "8px 16px",
  border: "none",
  borderRadius: "6px",
  background: isActive ? "rgba(255,255,255,0.1)" : "transparent",
  color: isActive ? color : "#8a8a9a",
  fontSize: "14px",
  fontFamily: "'DM Sans', sans-serif",
  fontWeight: "500",
  cursor: "pointer",
  transition: "all 0.2s ease",
});

const mainStyle = {
  display: "flex",
  flex: 1,
  gap: "20px",
  minHeight: 0,
};

const sidebarStyle = {
  width: "280px",
  flexShrink: 0,
};

const contentStyle = {
  flex: 1,
  minWidth: 0,
  overflow: "auto",
};

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
    <div style={appStyle}>
      <header style={headerStyle}>
        <div style={logoStyle}>
          <div style={logoIconStyle}></div>
          LLMUI
        </div>
        <nav style={tabsStyle}>
          {Object.values(TABS).map((tab) => (
            <button
              key={tab.key}
              style={tabStyle(activeTab === tab.key, tab.color)}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </header>

      <main style={mainStyle}>
        {activeTab === "chat" && (
          <aside style={sidebarStyle}>
            <ConversationHistory />
          </aside>
        )}
        <section style={contentStyle}>{renderContent()}</section>
      </main>
    </div>
  );
}
