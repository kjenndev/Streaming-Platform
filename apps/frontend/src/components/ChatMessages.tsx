import { useLayoutEffect, useRef } from 'react';
import type { ChatMessage } from '../chat';

const FOLLOW_THRESHOLD = 80;
// appendMessage retains object identity when trimming history. Stable keys let
// native scroll anchoring preserve the reader's position as old rows disappear.
const messageKeys = new WeakMap<ChatMessage, number>();
let nextMessageKey = 0;
function messageKey(message: ChatMessage) {
  let key = messageKeys.get(message);
  if (key === undefined) {
    key = nextMessageKey++;
    messageKeys.set(message, key);
  }
  return key;
}
export default function ChatMessages({ messages, username }: { messages: ChatMessage[]; username: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useLayoutEffect(() => {
    const node = ref.current;
    if (node && follow.current) node.scrollTop = node.scrollHeight;
  }, [messages]);
  return <div ref={ref} role="log" aria-label="Stream chat" className="flex-grow-1 overflow-y-auto p-3" style={{ backgroundColor: 'var(--bg)', flexBasis: 0, minHeight: 0, maxHeight: 1440 }}
    onScroll={event => {
      const node = event.currentTarget;
      follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < FOLLOW_THRESHOLD;
    }}>
    {/* History is capped at 500 messages by appendMessage; let wrapped rows size naturally. */}
    {messages.map(msg => <div data-testid="chat-row" key={messageKey(msg)} className="line-height-3 text-sm" style={{ overflowWrap: 'anywhere', paddingBottom: 4 }}>
      {msg.isSystem ? <span className="italic" style={{ color: 'var(--base01)' }}>{msg.message}</span> : <>
        <span className="font-bold mr-2" style={{ color: (msg.identity?.displayName || msg.username) === username ? 'var(--green)' : 'var(--blue)' }}>{msg.identity?.displayName || msg.username}{msg.identity?.verified && <span aria-label="Verified MSS artist"> ✓</span>}</span>
        <span style={{ color: 'var(--text)' }}>{msg.message}</span>
      </>}
    </div>)}
  </div>;
}
