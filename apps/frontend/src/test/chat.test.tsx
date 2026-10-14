import { expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import ChatMessages from '../components/ChatMessages';
import { appendMessage, type ChatMessage } from '../chat';

it('retains 500 recent messages in natural-height rows with accessible history', () => {
  let messages: ChatMessage[] = [];
  for (let i = 0; i < 10000; i++) messages = appendMessage(messages, { username: 'a', message: String(i) });
  expect(messages).toHaveLength(500);
  expect(messages[0].message).toBe('9500');
  const view = render(<ChatMessages messages={messages} username="a" />);
  expect(view.getAllByTestId('chat-row')).toHaveLength(500);
  for (const row of view.getAllByTestId('chat-row')) {
    expect(row.style.height).toBe('');
    expect(row.style.position).not.toBe('absolute');
  }
  fireEvent.scroll(view.getByRole('log'), { target: { scrollTop: 0 } });
  expect(view.getByText('9500')).toBeInTheDocument();
  expect(view.getByText('9999')).toBeInTheDocument();
});

it('follows new messages at the bottom but preserves a reader scrolling through history', () => {
  const messages = [{ username: 'me', message: 'First' }];
  const view = render(<ChatMessages messages={messages} username="me" />);
  const log = view.getByRole('log');
  Object.defineProperties(log, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 300 } });
  fireEvent.scroll(log, { target: { scrollTop: 200 } });
  view.rerender(<ChatMessages messages={[...messages, { username: 'other', message: 'Second' }]} username="me" />);
  expect(log.scrollTop).toBe(200);
  fireEvent.scroll(log, { target: { scrollTop: 700 } });
  view.rerender(<ChatMessages messages={[...messages, { username: 'other', message: 'Third' }]} username="me" />);
  expect(log.scrollTop).toBe(1000);
});

it('keeps system notices and usernames while rendering message markup as text', () => {
  const view = render(<ChatMessages messages={[
    { username: 'me', message: '<img src=x onerror=alert(1)>' },
    { username: 'other', message: 'https://example.invalid/chat' },
    { username: '', message: 'Synthetic notice', isSystem: true },
  ]} username="me" />);
  expect(view.getByText('me')).toHaveStyle({ color: 'var(--green)' });
  expect(view.getByText('other')).toHaveStyle({ color: 'var(--blue)' });
  expect(view.getByText('Synthetic notice')).toHaveClass('italic');
  expect(view.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
  expect(view.container.querySelector('img')).toBeNull();
});
