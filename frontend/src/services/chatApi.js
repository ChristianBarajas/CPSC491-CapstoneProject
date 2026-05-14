const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");

/**
 * Sends a streaming chat request to the backend.
 * Calls onChunk(text) for each streamed token, onDone() when complete.
 */
export async function streamChat({ messages, currentBuild, onChunk, onDone, onError }) {
  try {
    const response = await fetch(`${API_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ messages, currentBuild }),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => null);
      throw new Error(data?.error || "Chat request failed");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep incomplete line in buffer

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") {
          onDone?.();
          return;
        }
        try {
          const parsed = JSON.parse(payload);
          if (parsed.error) {
            onError?.(new Error(parsed.error));
            return;
          }
          if (parsed.content) {
            onChunk?.(parsed.content);
          }
        } catch {
          // ignore malformed lines
        }
      }
    }

    onDone?.();
  } catch (err) {
    onError?.(err);
  }
}
