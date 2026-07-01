import { useEffect, useState, useMemo } from "react";
import { useChatStore } from "./stores/chatStore.js";
import { useSettingsStore } from "./stores/settingsStore.js";
import { TABS } from "./constants/config.js";
import ChatView from "./components/chat/ChatView.jsx";
import ConversationHistory from "./components/history/ConversationHistory.jsx";
import ModelManager from "./components/models/ModelManager.jsx";
import SystemStats from "./components/stats/SystemStats.jsx";
import SettingsPanel from "./components/settings/SettingsPanel.jsx";
import KeyboardShortcutsPanel, {
  useKeyboardShortcuts,
} from "./components/shared/KeyboardShortcuts.jsx";
import SetupWizard from "./components/setup/SetupWizard.jsx";
import ServerSwitcher from "./components/shared/ServerSwitcher.jsx";
import "./App.css";

export default function App() {
  const [setupComplete, setSetupComplete] = useState(null); // null = checking
  const [activeTab, setActiveTab] = useState("chat");
  const [showShortcuts, setShowShortcuts] = useState(false);
  // Mobile-only: false shows the conversation list (like Signal/iMessage's
  // home screen), true pushes into the full-screen chat. Ignored on desktop
  // where the sidebar and chat are always shown side by side.
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const { loadConversations, createConversation } = useChatStore();
  const { loadSettings, defaultModel, theme } = useSettingsStore();

  // Check setup status before loading anything else
  useEffect(() => {
    fetch("/api/setup/status")
      .then((r) => r.json())
      .then((d) => setSetupComplete(d.complete))
      .catch(() => setSetupComplete(true)); // if check fails, don't block the UI
  }, []);

  useEffect(() => {
    if (!setupComplete) return;
    loadSettings();
    loadConversations();
  }, [setupComplete, loadSettings, loadConversations]);

  // Apply theme to document, including the browser chrome color (Safari's
  // status bar / toolbar default to white and ignore page CSS entirely
  // unless a theme-color meta tag tells them otherwise). Both the dark- and
  // light-scoped tags are kept pointed at the app's actual active theme
  // color, since which one Safari trusts depends on the device's own
  // system appearance setting, not the app's in-app theme choice.
  useEffect(() => {
    const resolvedTheme = theme || 'dark';
    document.documentElement.setAttribute('data-theme', resolvedTheme);
    const color = resolvedTheme === 'light' ? '#f1f5f9' : '#08080c';
    document
      .querySelectorAll('meta[name="theme-color"]')
      .forEach((meta) => meta.setAttribute('content', color));
  }, [theme]);

  // Keyboard shortcuts handlers
  const shortcutHandlers = useMemo(
    () => ({
      onNewConversation: async () => {
        setActiveTab("chat");
        await createConversation(defaultModel);
      },
      onToggleShortcuts: () => setShowShortcuts((v) => !v),
      onOpenSettings: () => setActiveTab("settings"),
      onSwitchTab: (tab) => setActiveTab(tab),
    }),
    [createConversation, defaultModel]
  );

  useKeyboardShortcuts(shortcutHandlers);

  const renderContent = () => {
    switch (activeTab) {
      case "chat":
        return <ChatView onBack={() => setMobileChatOpen(false)} />;
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

  // Wait for setup status check
  if (setupComplete === null) return null;

  // Show wizard on first run
  if (!setupComplete) {
    return <SetupWizard onComplete={() => setSetupComplete(true)} />;
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-logo">
          <div className="app-logo-icon"></div>
          <span className="app-logo-text">LLMUI</span>
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
          <button
            className="app-tab shortcuts-btn"
            onClick={() => setShowShortcuts(true)}
            title="Keyboard shortcuts (Ctrl+/)"
          >
            ?
          </button>
        </nav>
        <div className="app-header-right">
          <ServerSwitcher />
        </div>
      </header>

      <main className="app-main">
        {activeTab === "chat" && (
          <aside className={`app-sidebar ${mobileChatOpen ? "is-hidden-mobile" : ""}`}>
            <ConversationHistory onOpenChat={() => setMobileChatOpen(true)} />
          </aside>
        )}
        <section
          className={`app-content ${
            activeTab === "chat" && !mobileChatOpen ? "is-hidden-mobile" : ""
          }`}
        >
          {renderContent()}
        </section>
      </main>

      <KeyboardShortcutsPanel
        isOpen={showShortcuts}
        onClose={() => setShowShortcuts(false)}
      />
    </div>
  );
}
