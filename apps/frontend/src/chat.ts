export interface ChatMessage { username?: string; message: string; isSystem?: boolean }
export function appendMessage(messages: ChatMessage[], message: ChatMessage) {
  return [...messages.slice(-499), { ...message, message: message.message.slice(0, 4000), username: message.username?.slice(0, 100) }];
}
