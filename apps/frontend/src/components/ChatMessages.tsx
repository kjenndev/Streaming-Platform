import { useLayoutEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../chat';

const ROW_HEIGHT = 80;
const WINDOW_SIZE = 24;
export default function ChatMessages({ messages, username }: { messages: ChatMessage[]; username: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [start, setStart] = useState(0);
  useLayoutEffect(() => {
    const node = ref.current;
    if (node && follow.current) {
      node.scrollTop = node.scrollHeight;
      node.dispatchEvent(new Event('scroll', { bubbles: true }));
    }
  }, [messages]);
  const first = Math.min(start, Math.max(0, messages.length - 1));
  return <div ref={ref} role="log" aria-label="Stream chat" className="flex-grow-1 overflow-y-auto p-3" style={{ backgroundColor: 'var(--bg)', minHeight: 0, maxHeight: 1440 }}
    onScroll={event => {
      const node = event.currentTarget;
      follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < ROW_HEIGHT;
      setStart(Math.max(0, Math.floor(node.scrollTop / ROW_HEIGHT) - 2));
    }}>
    <div style={{ height: messages.length * ROW_HEIGHT, position: 'relative' }}>
      {messages.slice(first, first + WINDOW_SIZE).map((msg, i) => <div data-testid="chat-row" key={first + i} className="line-height-3 text-sm" style={{ position: 'absolute', top: (first + i) * ROW_HEIGHT, height: ROW_HEIGHT, width: '100%', overflow: 'auto', overflowWrap: 'anywhere', paddingBottom: 12 }}>
        {msg.isSystem ? <span className="italic" style={{ color: 'var(--base01)' }}>{msg.message}</span> : <>
          <span className="font-bold mr-2" style={{ color: msg.username === username ? 'var(--green)' : 'var(--blue)' }}>{msg.username}</span>
          <span style={{ color: 'var(--text)' }}>{msg.message}</span>
        </>}
      </div>)}
    </div>
  </div>;
}
