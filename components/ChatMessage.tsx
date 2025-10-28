
import React from 'react';
import { ChatMessage, Sender } from '../types';
import { BotIcon } from './icons/BotIcon';

interface ChatMessageProps {
  message: ChatMessage;
}

export const ChatMessageComponent: React.FC<ChatMessageProps> = ({ message }) => {
  const isUserModel = message.sender === Sender.Model;

  return (
    <div className={`flex items-start gap-4 my-4 ${isUserModel ? '' : 'flex-row-reverse'}`}>
      {isUserModel && (
        <div className="flex-shrink-0 w-10 h-10 rounded-full bg-gray-700 flex items-center justify-center">
          <BotIcon className="w-6 h-6 text-gray-300" />
        </div>
      )}
      <div
        className={`max-w-md lg:max-w-2xl rounded-2xl px-5 py-3 shadow-md ${
          isUserModel
            ? 'bg-gray-800 text-gray-200 rounded-bl-none'
            : 'bg-indigo-600 text-white rounded-br-none'
        }`}
      >
        <p className="whitespace-pre-wrap">{message.text}</p>
      </div>
    </div>
  );
};
