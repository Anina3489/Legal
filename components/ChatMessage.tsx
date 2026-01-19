import React from 'react';
import { ChatMessage, Sender } from '../types';
import { BotIcon } from './icons/BotIcon';

interface ChatMessageProps {
  message: ChatMessage;
}

export const ChatMessageComponent: React.FC<ChatMessageProps> = ({ message }) => {
  const isModel = message.sender === Sender.Model;

  return (
    <div className={`flex items-start gap-4 my-4 ${isModel ? '' : 'flex-row-reverse'}`}>
      {isModel && (
        <div className="flex-shrink-0 w-10 h-10 rounded-full bg-gray-700 flex items-center justify-center border border-gray-600 shadow-sm">
          <BotIcon className="w-6 h-6 text-indigo-400" />
        </div>
      )}
      <div
        className={`max-w-md lg:max-w-2xl rounded-2xl px-5 py-3 shadow-lg relative group ${
          isModel
            ? 'bg-gray-800 text-gray-200 rounded-bl-none border border-gray-700/50'
            : 'bg-indigo-600 text-white rounded-br-none border border-indigo-500/50'
        }`}
      >
        {isModel && (
          <div className="flex items-center gap-1.5 mb-1.5 border-b border-white/5 pb-1.5">
            <div className="w-1.5 h-1.5 bg-amber-500 rounded-full animate-pulse"></div>
            <span className="text-[9px] font-black text-amber-500 uppercase tracking-widest">Draft – For Advocate Review</span>
          </div>
        )}
        <p className="whitespace-pre-wrap text-[13px] md:text-sm leading-relaxed">{message.text}</p>
        
        <div className={`absolute bottom-0 ${isModel ? 'left-0' : 'right-0'} translate-y-full pt-1 opacity-0 group-hover:opacity-100 transition-opacity`}>
          <span className="text-[10px] text-gray-600 font-bold uppercase tracking-tighter">
            {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
      </div>
    </div>
  );
};