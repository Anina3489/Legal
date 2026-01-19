import React, { useState, useRef, useEffect, useCallback } from 'react';
import { GoogleGenAI, Chat, FunctionDeclaration, Type } from '@google/genai';
import { ChatMessage, Sender, IntakeFormData } from './types';
import { ChatInput } from './components/ChatInput';
import { ChatMessageComponent } from './components/ChatMessage';
import { ClientIntakeForm } from './components/ClientIntakeForm';

const STORAGE_KEY = 'hera_chat_history_v1';
const DISCLAIMER_KEY = 'hera_disclaimer_accepted_v1';

const DISCLAIMER_TEXT = "HERA is an AI-powered legal assistant designed to support information gathering and preliminary legal research. It does not provide legal advice. All outputs must be reviewed and approved by a qualified advocate of Odero & Gitau Advocates before use.";

const HERA_SYSTEM_PROMPT = `You are HERA, an AI-powered legal support assistant for Odero & Gitau Advocates, a Kenyan law firm. 

CORE DIRECTIVE:
You are assisting a qualified Kenyan advocate. Your role is to provide structured legal research and drafting support. Assume the legal competence of the user. You are NOT a lawyer and do NOT provide legal advice. All outputs are DRAFTS.

JURISDICTION & GROUNDING RULES:
- You MUST ONLY reference Kenyan law, Kenyan statutes (e.g., The Constitution of Kenya, Companies Act, Land Act), Kenyan courts, and Kenyan legal procedures.
- You may ONLY answer questions if supporting information is found in verified Kenyan legal sources (statutes, regulations, reported cases).
- If no verified Kenyan source is found or if the information is outside your verified knowledge, you MUST refuse to answer and state: “I do not have sufficient verified Kenyan legal information on this issue. Please consult an advocate of Odero & Gitau Advocates for a definitive opinion.”

DRAFTING PROTOCOLS (DEMAND LETTERS & OUTLINES):
- When drafting outlines (e.g., Plaints, Demand Letters):
  1. Use a NEUTRAL, NON-THREATENING, and PROFESSIONAL tone.
  2. DO NOT assert liability or make definitive legal conclusions. Use phrases like "Our instructions are that..." or "The position under Kenyan law appears to be...".
  3. Use PLACEHOLDERS (e.g., [Insert Date], [Insert Amount], [Insert Section]) for all missing facts or unverified citations.
  4. DO NOT invent facts or specific legal provisions.

PRIVACY & DATA HANDLING:
- Ask users for general background facts only (dates, parties, and the nature of the matter).
- Explicitly instruct users: "Please provide general background facts only (dates, parties, and nature of the matter). Do not include confidential documents or sensitive personal information in this chat. An advocate will review all information provided."

OUTPUT FORMATTING (MANDATORY TEMPLATE):
Every substantial response containing legal information MUST follow this exact structure:

DRAFT – FOR ADVOCATE REVIEW ONLY

Summary:
[Brief, neutral explanation of the legal context or information provided]

Legal Basis (Kenya):
- Statute: [Specific Act name and Section number]
- Case Law (if applicable): [Full Case name, Court, and Year]

Notes:
- Assumptions made: [List any assumptions you had to make]
- Missing information: [List what facts are needed for a full analysis]

CLIENT INTERACTION:
- Maintain a professional, confident, and empathetic tone.
- Use 'show_client_intake_form' when the user (on behalf of a client) is ready to record formal case details.`;

const showClientIntakeFormDeclaration: FunctionDeclaration = {
  name: 'show_client_intake_form',
  description: 'Displays a client intake form to collect user details like name, email, phone, case category, case description, and supporting documents. Use this when the user expresses interest in scheduling a consultation, submitting documents, or starting a new case.',
  parameters: {
    type: Type.OBJECT,
    properties: {},
  },
};

const getErrorMessage = (error: any): string => {
  const message = error?.message?.toLowerCase() || '';
  if (message.includes('401') || message.includes('403') || message.includes('api_key_invalid') || message.includes('key not found')) {
    return "HERA configuration error: The API key appears to be invalid. Please verify system configuration.";
  }
  if (message.includes('429')) {
    return "HERA is currently processing a high volume of inquiries. Please wait a moment.";
  }
  return "I encountered an issue. Please try again or refresh the page.";
};

const App: React.FC = () => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<{ message: string; isTransient: boolean } | null>(null);
  const [showIntakeForm, setShowIntakeForm] = useState(false);
  const [showDisclaimer, setShowDisclaimer] = useState(false);
  const chatRef = useRef<Chat | null>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);

  const initializeChat = useCallback((existingMessages: ChatMessage[] = []) => {
    try {
      if (!process.env.API_KEY) throw new Error("API_KEY_MISSING");

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      const history = existingMessages
        .filter(msg => !msg.text.startsWith('[System Note]'))
        .map(msg => ({
          role: msg.sender === Sender.User ? 'user' : 'model',
          parts: [{ text: msg.text }]
        }));

      chatRef.current = ai.chats.create({
        model: 'gemini-3-pro-preview',
        config: {
          systemInstruction: HERA_SYSTEM_PROMPT,
          tools: [{ functionDeclarations: [showClientIntakeFormDeclaration] }],
        },
        history: history as any,
      });

      if (existingMessages.length === 0) {
        const welcomeMessage: ChatMessage = {
          id: `hera-welcome-${Date.now()}`,
          sender: Sender.Model,
          text: `Welcome to Odero & Gitau Advocates. My name is HERA, your digital legal assistant.\n\nPlease provide general background facts only (dates, parties, and nature of the matter). Do not include confidential documents or sensitive personal information here.\n\nHow can I assist with your research or drafting today?`,
        };
        setMessages([welcomeMessage]);
      } else {
        setMessages(existingMessages);
      }
    } catch (e: any) {
      console.error('Chat init failed:', e);
      setError({ message: getErrorMessage(e), isTransient: true });
    }
  }, []);

  useEffect(() => {
    const disclaimerAccepted = localStorage.getItem(DISCLAIMER_KEY);
    if (!disclaimerAccepted) {
      setShowDisclaimer(true);
    }

    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        initializeChat(JSON.parse(saved));
      } catch (e) {
        initializeChat();
      }
    } else {
      initializeChat();
    }
  }, [initializeChat]);

  useEffect(() => {
    if (messages.length > 0) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
    }
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }
  }, [messages, showIntakeForm]);

  const handleAcceptDisclaimer = () => {
    localStorage.setItem(DISCLAIMER_KEY, 'true');
    setShowDisclaimer(false);
  };

  const handleClearHistory = () => {
    if (window.confirm("Clear chat history?")) {
      localStorage.removeItem(STORAGE_KEY);
      initializeChat([]);
    }
  };

  const handleSendMessage = async (text: string) => {
    if (!chatRef.current) return;

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
      
      if (response.text) {
          const modelMessage: ChatMessage = {
            id: `model-${Date.now()}`,
            sender: Sender.Model,
            text: response.text,
          };
          setMessages((prev) => [...prev, modelMessage]);
      }

      if (response.functionCalls) {
        for (const fc of response.functionCalls) {
            if (fc.name === 'show_client_intake_form') {
                setShowIntakeForm(true);
            }
        }
      }
    } catch (e: any) {
      console.error('API Error:', e);
      setError({ message: getErrorMessage(e), isTransient: true });
    } finally {
      setIsLoading(false);
    }
  };

  const handleFormSubmit = async (data: IntakeFormData) => {
    setShowIntakeForm(false);
    const docCount = data.documents.length;
    
    const summary = `
### SUBMISSION RECEIVED
Thank you, **${data.fullName}**. Your inquiry has been securely recorded.

**DETAILS PROVIDED:**
- **Case Category:** ${data.caseType}
- **Contact Email:** ${data.email}
- **Contact Phone:** ${data.phone}
- **Supporting Docs:** ${docCount > 0 ? `${docCount} file(s) attached` : 'No documents attached'}

**NEXT STEPS:**
An advocate from Odero & Gitau Advocates will review your submission and contact you within **1 to 2 business days**.
    `.trim();

    setMessages(prev => [...prev, { id: `sys-${Date.now()}`, sender: Sender.Model, text: summary }]);
    
    if (chatRef.current) {
        setIsLoading(true);
        try {
            const followUp = `User ${data.fullName} submitted the form for ${data.caseType}. Please provide a brief professional closing.`;
            const resp = await chatRef.current.sendMessage({ message: followUp });
            if (resp.text) {
                setMessages(prev => [...prev, { id: `m-${Date.now()}`, sender: Sender.Model, text: resp.text! }]);
            }
        } catch (e) {
            console.error(e);
        } finally {
            setIsLoading(false);
        }
    }
  };

  return (
    <div className="flex flex-col h-screen bg-gray-900 text-white font-sans selection:bg-indigo-500/30">
      {showDisclaimer && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-300">
          <div className="max-w-md w-full bg-gray-800 border border-gray-700 rounded-2xl shadow-2xl overflow-hidden animate-in zoom-in-95 duration-300">
            <div className="p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 bg-indigo-600/20 rounded-full flex items-center justify-center">
                  <span className="text-xl">⚖️</span>
                </div>
                <h2 className="text-xl font-bold text-white">Legal Notice & Disclaimer</h2>
              </div>
              <div className="space-y-4">
                <p className="text-sm text-gray-300 leading-relaxed italic">
                  "{DISCLAIMER_TEXT}"
                </p>
                <div className="p-3 bg-indigo-500/5 border border-indigo-500/10 rounded-xl">
                  <p className="text-[11px] text-gray-400 font-medium">
                    By proceeding, you acknowledge that HERA's responses are for guidance only and do not establish an advocate-client relationship.
                  </p>
                </div>
              </div>
            </div>
            <div className="p-4 bg-gray-900 border-t border-gray-700">
              <button 
                onClick={handleAcceptDisclaimer}
                className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-xl transition-all active:scale-[0.98] shadow-lg shadow-indigo-600/20"
              >
                I Understand & Proceed
              </button>
            </div>
          </div>
        </div>
      )}

      <header className="bg-gray-800 p-4 shadow-lg z-10 border-b border-gray-700 flex items-center justify-between">
        <div className="w-10"></div>
        <div className="flex flex-col items-center">
          <h1 className="text-xl md:text-2xl font-bold text-gray-100 tracking-tight flex items-center gap-2">
            <span className="text-indigo-500">⚖️</span> HERA Legal Assistant
          </h1>
          <p className="text-[10px] md:text-xs uppercase tracking-widest text-gray-500 font-semibold mt-1">Odero & Gitau Advocates</p>
        </div>
        <button 
          onClick={handleClearHistory}
          className="p-2 text-gray-500 hover:text-red-400 hover:bg-red-400/10 rounded-full transition-all group relative"
          aria-label="Clear Chat History"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>
      </header>

      <main ref={chatContainerRef} className="flex-grow overflow-y-auto p-4 md:p-6 space-y-2 scroll-smooth">
        <div className="max-w-4xl mx-auto w-full">
          {messages.map((msg) => (
            <ChatMessageComponent key={msg.id} message={msg} />
          ))}
          
          {showIntakeForm && (
            <div className="my-6">
              <ClientIntakeForm 
                onSubmit={handleFormSubmit} 
                onCancel={() => setShowIntakeForm(false)} 
              />
            </div>
          )}
          
          {isLoading && (
            <div className="flex items-center gap-2 text-gray-500 text-sm italic animate-pulse px-4 py-2">
              <div className="w-2 h-2 bg-indigo-500 rounded-full"></div>
              HERA is thinking...
            </div>
          )}
          
          {error && (
            <div className="mx-4 my-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-sm flex items-center gap-3">
               <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                 <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
               </svg>
               {error.message}
            </div>
          )}
        </div>
      </main>

      <div className="w-full max-w-4xl mx-auto">
        <div className="px-6 py-2 bg-gray-900/50 border-t border-gray-800">
          <p className="text-[9px] md:text-[10px] text-gray-500 font-medium text-center leading-tight uppercase tracking-wider">
            {DISCLAIMER_TEXT}
          </p>
        </div>
        <ChatInput 
          onSendMessage={handleSendMessage} 
          isLoading={isLoading} 
          isFormVisible={showIntakeForm}
        />
      </div>
    </div>
  );
};

export default App;