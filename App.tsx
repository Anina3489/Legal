
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { GoogleGenAI, Chat } from '@google/genai';
import { ChatMessage, Sender } from './types';
import { ChatInput } from './components/ChatInput';
import { ChatMessageComponent } from './components/ChatMessage';

const HERA_SYSTEM_PROMPT = `You are HERA, the official AI legal assistant for Odero & Gitau Advocates, a premier Kenyan law firm specializing in commercial transactions, conveyancing, debt recovery, and legal audits.

Speak in a professional, confident, and empathetic tone. You are not a replacement for a human lawyer but a knowledgeable guide who helps clients understand legal procedures, schedule consultations, and navigate firm services efficiently.

Your goals:
- Welcome clients warmly and identify their legal needs.
- Provide general legal guidance in simple terms (no legal advice or binding opinions).
- Assist with bookings and document submission by collecting names, contact info, and case details.
- Direct complex queries or confidential matters to a human lawyer.
- Maintain strict confidentiality, professionalism, and compliance with Kenyan legal ethics.

Use polite, human-like phrasing such as:
- “Welcome to Odero & Gitau Advocates. My name is HERA, your digital legal assistant.”
- “Could you please tell me a bit about your legal concern?”
- “I can help you schedule a meeting with one of our advocates.”
- “Your privacy is important to us — I will only collect the details necessary to assist you.”

You should never:
- Provide explicit legal advice, judgments, or interpretations of active cases.
- Create or edit legal documents.
- Share private client information outside the conversation.

When unsure, respond with:
“That’s a great question. Let me connect you with one of our advocates for a detailed response.”

Tone & Personality:
Calm, articulate, and trustworthy — like a digital paralegal who embodies the grace of justice and the professionalism of the firm.`;

const App: React.FC = () => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chatRef = useRef<Chat | null>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);

  const initializeChat = useCallback(() => {
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY as string });
      chatRef.current = ai.chats.create({
        model: 'gemini-2.5-flash',
        config: {
          systemInstruction: HERA_SYSTEM_PROMPT,
        },
      });

      const welcomeMessage: ChatMessage = {
        id: `hera-welcome-${Date.now()}`,
        sender: Sender.Model,
        text: "Welcome to Odero & Gitau Advocates. My name is HERA, your digital legal assistant. How can I help you today?",
      };
      setMessages([welcomeMessage]);
    } catch (e) {
      console.error('Failed to initialize chat:', e);
      setError('Failed to initialize the assistant. Please check the API key and refresh the page.');
    }
  }, []);

  useEffect(() => {
    initializeChat();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSendMessage = async (text: string) => {
    if (!chatRef.current) {
        setError("Chat is not initialized. Please refresh the page.");
        return;
    }

    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      sender: Sender.User,
      text,
    };
    setMessages((prev) => [...prev, userMessage]);
    setIsLoading(true);
    setError(null);

    try {
      const response = await chatRef.current.sendMessage({ message: text });
      const modelMessage: ChatMessage = {
        id: `model-${Date.now()}`,
        sender: Sender.Model,
        text: response.text,
      };
      setMessages((prev) => [...prev, modelMessage]);
    } catch (e) {
      console.error('Gemini API Error:', e);
      const errorMessage: ChatMessage = {
        id: `error-${Date.now()}`,
        sender: Sender.Model,
        text: "I'm sorry, but I encountered an issue while processing your request. Please try again shortly.",
      };
      setMessages((prev) => [...prev, errorMessage]);
      setError('An error occurred while fetching the response.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-gray-900 text-white font-sans">
      <header className="bg-gray-800 p-4 shadow-md z-10 border-b border-gray-700">
        <h1 className="text-xl md:text-2xl font-bold text-center text-gray-200">
          HERA - Legal Assistant
        </h1>
        <p className="text-center text-sm text-gray-400">Odero & Gitau Advocates</p>
      </header>
      <main ref={chatContainerRef} className="flex-1 overflow-y-auto p-4 md:p-6 space-y-4">
         {messages.map((msg) => (
          <ChatMessageComponent key={msg.id} message={msg} />
        ))}
        {isLoading && (
            <div className="flex items-start gap-4 my-4">
                 <div className="flex-shrink-0 w-10 h-10 rounded-full bg-gray-700 flex items-center justify-center">
                    <div className="w-6 h-6 text-gray-300">⚖️</div>
                 </div>
                 <div className="max-w-md lg:max-w-2xl rounded-2xl px-5 py-4 shadow-md bg-gray-800 text-gray-200 rounded-bl-none flex items-center space-x-2">
                    <div className="w-2 h-2 bg-gray-400 rounded-full animate-pulse [animation-delay:-0.3s]"></div>
                    <div className="w-2 h-2 bg-gray-400 rounded-full animate-pulse [animation-delay:-0.15s]"></div>
                    <div className="w-2 h-2 bg-gray-400 rounded-full animate-pulse"></div>
                 </div>
            </div>
        )}
        {error && (
            <div className="flex justify-center">
                 <div className="bg-red-900/50 text-red-300 border border-red-700 rounded-lg px-4 py-2">
                    {error}
                </div>
            </div>
        )}
      </main>
      <footer className="sticky bottom-0 left-0 right-0">
        <ChatInput onSendMessage={handleSendMessage} isLoading={isLoading} />
      </footer>
    </div>
  );
};

export default App;
