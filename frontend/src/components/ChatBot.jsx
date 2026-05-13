import { useState, useRef, useEffect } from "react";
import { streamChat } from "../services/chatApi";
import "../styles/ChatBot.css";

const WELCOME_MESSAGE = {
  role: "assistant",
  content: "Hi! I'm your PC build assistant. Ask me anything about components, compatibility, or building on a budget.",
};

export default function ChatBot({ currentBuild }) {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState([WELCOME_MESSAGE]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const bottomRef = useRef(null);
  const inputRef = useRef(null);
  const abortRef = useRef(false);

  // Scroll to bottom whenever messages change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Focus input when chat opens
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  async function handleSend() {
    const text = input.trim();
    if (!text || isStreaming) return;

    const userMessage = { role: "user", content: text };
    const history = [...messages, userMessage];

    setMessages(history);
    setInput("");
    setIsStreaming(true);
    abortRef.current = false;

    // Add empty assistant message to stream into
    setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

    // Only send non-welcome messages as history
    const apiMessages = history
      .filter((m) => !(m.role === "assistant" && m.content === WELCOME_MESSAGE.content))
      .map(({ role, content }) => ({ role, content }));

    await streamChat({
      messages: apiMessages,
      currentBuild,
      onChunk: (chunk) => {
        if (abortRef.current) return;
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          updated[updated.length - 1] = { ...last, content: last.content + chunk };
          return updated;
        });
      },
      onDone: () => setIsStreaming(false),
      onError: (err) => {
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            role: "assistant",
            content: "Sorry, something went wrong. Please try again.",
          };
          return updated;
        });
        setIsStreaming(false);
      },
    });
  }

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleClear() {
    abortRef.current = true;
    setIsStreaming(false);
    setMessages([WELCOME_MESSAGE]);
    setInput("");
  }

  return (
    <>
      {/* Floating toggle button */}
      <button
        className="chatbot-fab"
        onClick={() => setIsOpen((o) => !o)}
        aria-label={isOpen ? "Close chat assistant" : "Open chat assistant"}
      >
        {isOpen ? (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        ) : (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        )}
      </button>

      {/* Chat window */}
      {isOpen && (
        <div className="chatbot-window" role="dialog" aria-label="PC Build Assistant">
          <div className="chatbot-header">
            <div className="chatbot-header__info">
              <div className="chatbot-header__dot" aria-hidden="true" />
              <span className="chatbot-header__title">PC Build Assistant</span>
            </div>
            <button className="chatbot-header__clear" onClick={handleClear} title="Clear chat">
              Clear
            </button>
          </div>

          <div className="chatbot-messages" aria-live="polite">
            {messages.map((msg, i) => (
              <div key={i} className={`chatbot-msg chatbot-msg--${msg.role}`}>
                <div className="chatbot-msg__bubble">
                  {msg.content || (isStreaming && i === messages.length - 1 ? (
                    <span className="chatbot-typing">
                      <span /><span /><span />
                    </span>
                  ) : "")}
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          <div className="chatbot-input-row">
            <textarea
              ref={inputRef}
              className="chatbot-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask about builds, compatibility..."
              rows={1}
              disabled={isStreaming}
              aria-label="Chat message input"
            />
            <button
              className="chatbot-send"
              onClick={handleSend}
              disabled={!input.trim() || isStreaming}
              aria-label="Send message"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </>
  );
}
