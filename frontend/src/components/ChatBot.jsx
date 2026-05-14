import { useState, useRef, useEffect } from "react";
import { animate } from "animejs";
import { streamChat } from "../services/chatApi";
import "../styles/ChatBot.css";

const WELCOME_MESSAGE = {
  role: "assistant",
  content: "Hi! I'm your PC build assistant. Ask me anything about components, compatibility, or building on a budget.",
};

export default function ChatBot({ currentBuild }) {
  const [isOpen, setIsOpen] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [messages, setMessages] = useState([WELCOME_MESSAGE]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [fabPos, setFabPos] = useState({ right: 28, bottom: 28 });
  const bottomRef = useRef(null);
  const inputRef = useRef(null);
  const abortRef = useRef(false);
  const fabRef = useRef(null);
  const windowRef = useRef(null);
  const dragRef = useRef({ dragging: false, startY: 0, moved: false });

  // Drag handlers for the FAB — y-axis only
  function handlePointerDown(e) {
    dragRef.current = {
      dragging: true,
      startY: e.clientY,
      moved: false,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e) {
    if (!dragRef.current.dragging) return;

    const dy = e.clientY - dragRef.current.startY;

    // Only start moving after 5px threshold
    if (!dragRef.current.moved && Math.abs(dy) < 5) return;
    dragRef.current.moved = true;

    setFabPos((prev) => ({
      ...prev,
      bottom: Math.max(8, Math.min(window.innerHeight - 62, prev.bottom - dy)),
    }));

    dragRef.current.startY = e.clientY;
  }

  function handlePointerUp() {
    const wasDrag = dragRef.current.moved;
    dragRef.current.dragging = false;

    // Only toggle chat if it was a click, not a drag
    if (!wasDrag) {
      if (isOpen) {
        handleClose();
      } else {
        setIsOpen(true);
      }
    }
  }

  // Close with animation
  function handleClose() {
    if (isClosing) return;
    setIsClosing(true);

    if (windowRef.current) {
      animate(windowRef.current, {
        opacity: [1, 0],
        translateY: [0, 12],
        scale: [1, 0.97],
        duration: 250,
        ease: 'in(2)',
        onComplete: () => {
          setIsOpen(false);
          setIsClosing(false);
        },
      });
    } else {
      setIsOpen(false);
      setIsClosing(false);
    }
  }

  // Animate FAB on mount with a pulse + bounce
  useEffect(() => {
    if (fabRef.current) {
      animate(fabRef.current, {
        scale: [0, 1.15, 1],
        rotate: ['-45deg', '0deg'],
        duration: 800,
        ease: 'out(3)',
      });

      // Subtle looping pulse glow
      animate(fabRef.current, {
        boxShadow: [
          '0 4px 24px rgba(138, 43, 226, 0.5)',
          '0 4px 36px rgba(138, 43, 226, 0.85)',
          '0 4px 24px rgba(138, 43, 226, 0.5)',
        ],
        duration: 2000,
        loop: true,
        ease: 'inOut(2)',
      });
    }
  }, []);

  // Animate FAB on open/close toggle
  useEffect(() => {
    if (fabRef.current) {
      animate(fabRef.current, {
        rotate: isOpen ? '90deg' : '0deg',
        scale: [0.85, 1],
        duration: 300,
        ease: 'out(3)',
      });
    }
  }, [isOpen]);

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
        ref={fabRef}
        className="chatbot-fab"
        style={{ right: fabPos.right, bottom: fabPos.bottom }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
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
      {(isOpen || isClosing) && (
        <div
          ref={windowRef}
          className="chatbot-window"
          role="dialog"
          aria-label="PC Build Assistant"
          style={{ right: fabPos.right, bottom: fabPos.bottom + 66 }}
        >
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
