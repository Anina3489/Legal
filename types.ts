
export enum Sender {
  User = 'user',
  Model = 'model',
}

export interface ChatMessage {
  id: string;
  sender: Sender;
  text: string;
}
