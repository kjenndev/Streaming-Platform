import { expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import ChatMessages from '../components/ChatMessages';
import { appendMessage, type ChatMessage } from '../chat';
it('retains only 500 recent messages and mounts at most 24 rows while allowing history scrolling', () => {
  let messages: ChatMessage[] = [];
  for (let i = 0; i < 10000; i++) messages = appendMessage(messages, { username: 'a', message: String(i) });
  expect(messages).toHaveLength(500);
  expect(messages[0].message).toBe('9500');
  const view = render(<ChatMessages messages={messages} username="a" />);
  expect(view.getAllByTestId('chat-row').length).toBeLessThanOrEqual(24);
  const log = view.getByRole('log');
  fireEvent.scroll(log, { target: { scrollTop: 0 } });
  expect(view.getByText('9500')).toBeInTheDocument();
});
