import React, { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import JSZip from 'jszip';
import { GoogleGenAI, Type } from '@google/genai';
import { IntakeFormData, AttachedDocument, Annotation, AnnotationType } from '../types';
import { MicrophoneIcon } from './icons/MicrophoneIcon';

// Types for the Web Speech API
interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}

interface SpeechRecognitionResultList {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionAlternative {
  readonly transcript: string;
}

interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string;
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: (event: SpeechRecognitionEvent) => void;
  onend: () => void;
  onerror: (event: SpeechRecognitionErrorEvent) => void;
}

interface SpeechRecognitionStatic {
  new (): SpeechRecognition;
}

interface CustomWindow extends Window {
  SpeechRecognition?: SpeechRecognitionStatic;
  webkitSpeechRecognition?: SpeechRecognitionStatic;
}
declare const window: CustomWindow;

interface ClientIntakeFormProps {
  onSubmit: (data: IntakeFormData) => void;
  onCancel: () => void;
}

interface UploadingFile {
  id: string;
  name: string;
  progress: number;
}

type SortCriterion = 'name' | 'date' | 'expiry';
type SortDirection = 'asc' | 'desc';

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
const RETENTION_PERIOD_MS = 30 * 24 * 60 * 60 * 1000; // 30 days default expiration

const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg',
  'image/jpg'
];

const CASE_TYPES = [
  'Commercial Transactions',
  'Conveyancing & Real Estate',
  'Debt Recovery',
  'Legal Audits',
  'Family Law & Succession',
  'Employment & Labor Relations',
  'Civil Litigation',
  'Intellectual Property',
  'Other'
];

const COUNTRY_CODES = [
  { code: '+254', label: '🇰🇪 KE' },
  { code: '+256', label: '🇺🇬 UG' },
  { code: '+255', label: '🇹🇿 TZ' },
  { code: '+250', label: '🇷🇼 RW' },
  { code: '+251', label: '🇪🇹 ET' },
  { code: '+252', label: '🇸🇴 SO' },
  { code: '+253', label: '🇩🇯 DJ' },
  { code: '+211', label: '🇸🇸 SS' },
  { code: '+27', label: '🇿🇦 ZA' },
  { code: '+44', label: '🇬🇧 UK' },
  { code: '+1', label: '🇺🇸 US' },
  { code: '+971', label: '🇦🇪 AE' },
];

const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

export const ClientIntakeForm: React.FC<ClientIntakeFormProps> = ({ onSubmit, onCancel }) => {
  const [formData, setFormData] = useState<Omit<IntakeFormData, 'documents'>>({
    fullName: '',
    email: '',
    phone: '',
    caseType: '',
    caseDetails: '',
  });
  const [selectedCountryCode, setSelectedCountryCode] = useState('+254');
  const [documents, setDocuments] = useState<AttachedDocument[]>([]);
  const [uploadingFiles, setUploadingFiles] = useState<UploadingFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isZipping, setIsZipping] = useState(false);
  const [previewDoc, setPreviewDoc] = useState<AttachedDocument | null>(null);
  const [fileErrors, setFileErrors] = useState<string[]>([]);
  const [emailError, setEmailError] = useState<string>('');
  const [sortCriterion, setSortCriterion] = useState<SortCriterion>('date');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [isListeningDetails, setIsListeningDetails] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [isParsing, setIsParsing] = useState(false);

  // Bulk Action State
  const [isBulkMode, setIsBulkMode] = useState(false);
  const [selectedDocTimestamps, setSelectedDocTimestamps] = useState<Set<number>>(new Set());
  const [bulkAnnotationText, setBulkAnnotationText] = useState('');
  const [isApplyingBulk, setIsApplyingBulk] = useState(false);

  // Preview Annotation & Search State
  const [activeTool, setActiveTool] = useState<AnnotationType | null>(null);
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(null);
  const [annotationText, setAnnotationText] = useState('');
  const [pdfSearchQuery, setPdfSearchQuery] = useState('');
  const [pdfSearchResults, setPdfSearchResults] = useState<string | null>(null);
  const [isSearchingInPdf, setIsSearchingInPdf] = useState(false);
  const [collapsedAnnotations, setCollapsedAnnotations] = useState<Set<string>>(new Set());

  // Drawing State
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState({ x: 0, y: 0 });
  const [currentDraw, setCurrentDraw] = useState<{ x: number, y: number, w?: number, h?: number, ex?: number, ey?: number } | null>(null);

  // Camera State
  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Preview Manipulation State
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDraggingImage, setIsDraggingImage] = useState(false);
  const dragStartPos = useRef({ x: 0, y: 0 });
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pdfParseInputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const previewContainerRef = useRef<HTMLDivElement>(null);
  const docElementRef = useRef<HTMLDivElement>(null);

  // Initialize Speech Recognition for Case Details
  useEffect(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onresult = (event) => {
      let interimTranscript = '';
      let finalTranscript = '';
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          finalTranscript += event.results[i][0].transcript;
        } else {
          interimTranscript += event.results[i][0].transcript;
        }
      }
      
      if (finalTranscript || interimTranscript) {
        setFormData(prev => ({
          ...prev,
          caseDetails: prev.caseDetails + (finalTranscript || interimTranscript)
        }));
      }
    };
    
    recognition.onend = () => setIsListeningDetails(false);
    recognition.onerror = (event) => {
      console.error('Speech recognition error', event.error);
      setIsListeningDetails(false);
    };
    
    recognitionRef.current = recognition;

    return () => recognition.stop();
  }, []);

  const handleToggleVoiceDetails = () => {
    if (!recognitionRef.current) return;
    if (isListeningDetails) {
      recognitionRef.current.stop();
    } else {
      recognitionRef.current.start();
      setIsListeningDetails(true);
    }
  };

  const handlePdfAutoFill = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || file.type !== 'application/pdf') return;

    setIsParsing(true);
    try {
      const reader = new FileReader();
      const base64Promise = new Promise<string>((resolve) => {
        reader.onload = () => resolve((reader.result as string).split(',')[1]);
        reader.readAsDataURL(file);
      });

      const base64Data = await base64Promise;
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: [
          {
            parts: [
              {
                inlineData: {
                  mimeType: 'application/pdf',
                  data: base64Data
                }
              },
              {
                text: `Extract the following client intake information from this document. 
                - Full Name
                - Email Address
                - Phone Number (extract the digits only)
                - Legal Matter Category (Map to exactly one of these: ${CASE_TYPES.join(', ')})
                - Brief Case Details (A summary of the legal issue described)
                
                If a field is not found, leave it as an empty string. Return strictly valid JSON.`
              }
            ]
          }
        ],
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              fullName: { type: Type.STRING },
              email: { type: Type.STRING },
              phone: { type: Type.STRING },
              caseType: { type: Type.STRING },
              caseDetails: { type: Type.STRING }
            },
            required: ['fullName', 'email', 'phone', 'caseType', 'caseDetails']
          }
        }
      });

      const result = JSON.parse(response.text || '{}');
      
      setFormData({
        fullName: result.fullName || '',
        email: result.email || '',
        phone: result.phone || '',
        caseType: CASE_TYPES.includes(result.caseType) ? result.caseType : '',
        caseDetails: result.caseDetails || ''
      });

      const now = Date.now();
      const attachedDoc: AttachedDocument = {
        name: file.name,
        type: file.type,
        size: file.size,
        data: base64Data,
        uploadedAt: now,
        expiresAt: now + RETENTION_PERIOD_MS,
        annotations: []
      };
      setDocuments(prev => [...prev, attachedDoc]);

    } catch (err) {
      console.error('PDF Parsing failed:', err);
      alert('HERA could not read this PDF. Please fill the form manually or try a different file.');
    } finally {
      setIsParsing(false);
      if (pdfParseInputRef.current) pdfParseInputRef.current.value = '';
    }
  };

  const handlePdfSearch = async () => {
    if (!pdfSearchQuery.trim() || !previewDoc || previewDoc.type !== 'application/pdf') return;
    setIsSearchingInPdf(true);
    setPdfSearchResults(null);

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: [
          {
            parts: [
              { inlineData: { mimeType: 'application/pdf', data: previewDoc.data } },
              { text: `The user is searching for: "${pdfSearchQuery}". 
              Please find all occurrences or relevant information about this in the provided PDF. 
              Summarize what was found and provide page numbers or sections if visible. 
              If not found, simply say "I couldn't find any information regarding '${pdfSearchQuery}' in this document."` }
            ]
          }
        ]
      });
      setPdfSearchResults(response.text || 'No results found.');
    } catch (error) {
      console.error('PDF Search failed:', error);
      setPdfSearchResults('Search failed. Please try again.');
    } finally {
      setIsSearchingInPdf(false);
    }
  };

  const handleMouseDownOnDoc = (e: React.MouseEvent) => {
    if (!activeTool || !docElementRef.current) {
        if (zoom > 1 || rotation !== 0) {
            setIsDraggingImage(true);
            dragStartPos.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
        }
        return;
    }

    const rect = docElementRef.current.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;

    if (activeTool === 'pin') {
        const newAnn: Annotation = {
            id: Math.random().toString(36).substr(2, 9),
            type: 'pin',
            x,
            y,
            text: '',
            author: formData.fullName || 'User',
            createdAt: Date.now()
        };
        addAnnotation(newAnn);
        setActiveTool(null);
    } else {
        setIsDrawing(true);
        setDrawStart({ x, y });
        setCurrentDraw({ x, y });
    }
  };

  const handleMouseMoveOnDoc = (e: React.MouseEvent) => {
    if (isDraggingImage) {
        setPan({
            x: e.clientX - dragStartPos.current.x,
            y: e.clientY - dragStartPos.current.y
        });
        return;
    }

    if (!isDrawing || !docElementRef.current || !activeTool) return;

    const rect = docElementRef.current.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;

    if (activeTool === 'rect') {
        setCurrentDraw({
            x: Math.min(drawStart.x, x),
            y: Math.min(drawStart.y, y),
            w: Math.abs(x - drawStart.x),
            h: Math.abs(y - drawStart.y)
        });
    } else if (activeTool === 'arrow') {
        setCurrentDraw({
            x: drawStart.x,
            y: drawStart.y,
            ex: x,
            ey: y
        });
    }
  };

  const handleMouseUpOnDoc = () => {
    if (isDraggingImage) {
        setIsDraggingImage(false);
        return;
    }

    if (!isDrawing || !currentDraw || !activeTool) {
        setIsDrawing(false);
        return;
    }

    const newAnn: Annotation = {
        id: Math.random().toString(36).substr(2, 9),
        type: activeTool,
        x: currentDraw.x,
        y: currentDraw.y,
        width: currentDraw.w,
        height: currentDraw.h,
        endX: currentDraw.ex,
        endY: currentDraw.ey,
        text: '',
        author: formData.fullName || 'User',
        createdAt: Date.now()
    };

    addAnnotation(newAnn);
    setIsDrawing(false);
    setCurrentDraw(null);
    setActiveTool(null);
  };

  const addAnnotation = (ann: Annotation) => {
    if (previewDoc) {
      const updatedDoc = {
        ...previewDoc,
        annotations: [...(previewDoc.annotations || []), ann]
      };
      setPreviewDoc(updatedDoc);
      setDocuments(prev => prev.map(d => d.uploadedAt === previewDoc.uploadedAt ? updatedDoc : d));
      setActiveAnnotationId(ann.id);
      setAnnotationText('');
      // Ensure the new annotation is expanded for immediate feedback
      setCollapsedAnnotations(prev => {
        const next = new Set(prev);
        next.delete(ann.id);
        return next;
      });
    }
  };

  const selectAnnotation = (ann: Annotation) => {
    setActiveAnnotationId(ann.id);
    setAnnotationText(ann.text || '');
    setCollapsedAnnotations(prev => {
      const next = new Set(prev);
      next.delete(ann.id); // Ensure it's expanded in the sidebar list for context
      return next;
    });
  };

  const toggleAnnotationCollapse = (id: string) => {
    setCollapsedAnnotations(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const saveAnnotationText = () => {
    if (!activeAnnotationId || !previewDoc) return;
    const currentId = activeAnnotationId;
    const updatedDoc = {
      ...previewDoc,
      annotations: (previewDoc.annotations || []).map(a => 
        a.id === currentId ? { ...a, text: annotationText } : a
      )
    };
    setPreviewDoc(updatedDoc);
    setDocuments(prev => prev.map(d => d.uploadedAt === previewDoc.uploadedAt ? updatedDoc : d));
    
    // Automatically collapse after saving to clear up space and provide visual confirmation
    setCollapsedAnnotations(prev => {
        const next = new Set(prev);
        next.add(currentId);
        return next;
    });

    setActiveAnnotationId(null);
    setAnnotationText('');
  };

  const cancelAnnotationEdit = () => {
    if (!activeAnnotationId || !previewDoc) return;
    
    // Check if the annotation is new (has no text)
    const currentAnn = (previewDoc.annotations || []).find(a => a.id === activeAnnotationId);
    if (currentAnn && !currentAnn.text && !annotationText) {
        // If it's a new empty annotation, remove it entirely
        deleteAnnotation(activeAnnotationId);
    } else {
        // Just stop editing and collapse it
        setCollapsedAnnotations(prev => {
            const next = new Set(prev);
            next.add(activeAnnotationId!);
            return next;
        });
        setActiveAnnotationId(null);
        setAnnotationText('');
    }
  };

  const deleteAnnotation = (id: string) => {
    if (!previewDoc) return;
    const updatedDoc = {
      ...previewDoc,
      annotations: (previewDoc.annotations || []).filter(a => a.id !== id)
    };
    setPreviewDoc(updatedDoc);
    setDocuments(prev => prev.map(d => d.uploadedAt === previewDoc.uploadedAt ? updatedDoc : d));
    
    if (activeAnnotationId === id) {
      setActiveAnnotationId(null);
      setAnnotationText('');
    }
  };

  const sortedDocuments = useMemo(() => {
    return [...documents]
      .filter(doc => doc.name.toLowerCase().includes(searchTerm.toLowerCase()))
      .sort((a, b) => {
        let comparison = 0;
        if (sortCriterion === 'name') comparison = a.name.localeCompare(b.name);
        else if (sortCriterion === 'expiry') comparison = a.expiresAt - b.expiresAt;
        else if (sortCriterion === 'date') comparison = a.uploadedAt - b.uploadedAt;
        return sortDirection === 'asc' ? comparison : -comparison;
      });
  }, [documents, sortCriterion, sortDirection, searchTerm]);

  const handleBulkToggle = (timestamp: number) => {
    setSelectedDocTimestamps(prev => {
      const next = new Set(prev);
      if (next.has(timestamp)) next.delete(timestamp);
      else next.add(timestamp);
      return next;
    });
  };

  const handleSelectAll = () => {
    if (selectedDocTimestamps.size === sortedDocuments.length) {
      setSelectedDocTimestamps(new Set());
    } else {
      setSelectedDocTimestamps(new Set(sortedDocuments.map(d => d.uploadedAt)));
    }
  };

  const applyBulkAnnotation = () => {
    if (!bulkAnnotationText.trim() || selectedDocTimestamps.size === 0) return;
    setIsApplyingBulk(true);

    const now = Date.now();
    const author = formData.fullName || 'User';

    setDocuments(prev => prev.map(doc => {
      if (selectedDocTimestamps.has(doc.uploadedAt)) {
        const newAnn: Annotation = {
          id: Math.random().toString(36).substr(2, 9),
          type: 'pin',
          x: 5, // Default top-left position for bulk tags
          y: 5,
          text: bulkAnnotationText,
          author,
          createdAt: now
        };
        return {
          ...doc,
          annotations: [...(doc.annotations || []), newAnn]
        };
      }
      return doc;
    }));

    // Reset bulk state
    setBulkAnnotationText('');
    setSelectedDocTimestamps(new Set());
    setIsApplyingBulk(false);
    setIsBulkMode(false);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
    if (name === 'email') {
      setEmailError('');
    }
  };

  const processFile = (file: File): Promise<AttachedDocument> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      const fileId = Math.random().toString(36).substr(2, 9);
      
      setUploadingFiles(prev => [...prev, { id: fileId, name: file.name, progress: 0 }]);

      reader.onprogress = (event) => {
        if (event.lengthComputable) {
          const progress = Math.round((event.loaded / event.total) * 100);
          setUploadingFiles(prev => 
            prev.map(f => f.id === fileId ? { ...f, progress } : f)
          );
        }
      };

      reader.onload = () => {
        const result = reader.result as string;
        const base64 = result.split(',')[1];
        setUploadingFiles(prev => prev.filter(f => f.id !== fileId));
        const now = Date.now();
        resolve({
          name: file.name,
          type: file.type,
          size: file.size,
          data: base64,
          uploadedAt: now,
          expiresAt: now + RETENTION_PERIOD_MS,
          annotations: []
        });
      };

      reader.onerror = () => {
        setUploadingFiles(prev => prev.filter(f => f.id !== fileId));
        reject(new Error(`Failed to read ${file.name}`));
      };

      reader.readAsDataURL(file);
    });
  };

  const handleFiles = async (files: FileList) => {
    setFileErrors([]);
    const validFiles: File[] = [];
    const errors: string[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!ALLOWED_MIME_TYPES.includes(file.type)) {
        errors.push(`"${file.name}" is not supported. Please use PDF, Word (.docx), or Image (.jpg) files only.`);
        continue;
      }
      if (file.size > MAX_FILE_SIZE_BYTES) {
        errors.push(`"${file.name}" exceeds the 10MB limit. Please upload a smaller version or a compressed file.`);
        continue;
      }
      validFiles.push(file);
    }

    if (errors.length > 0) setFileErrors(errors);

    if (validFiles.length > 0) {
      try {
        const processedDocs = await Promise.all(validFiles.map(processFile));
        setDocuments(prev => [...prev, ...processedDocs]);
      } catch (err) {
        setFileErrors(prev => [...prev, "One or more files failed to process. Please try again."]);
      }
    }

    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) handleFiles(e.target.files);
  };

  const openCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }, 
        audio: false 
      });
      setCameraStream(stream);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      setIsCameraOpen(true);
      setCapturedImage(null);
    } catch (err) {
      console.error('Error accessing camera:', err);
      alert('Unable to access camera. Please check your permissions.');
    }
  };

  const closeCamera = () => {
    if (cameraStream) {
      cameraStream.getTracks().forEach(track => track.stop());
    }
    setCameraStream(null);
    setIsCameraOpen(false);
    setCapturedImage(null);
  };

  const capturePhoto = () => {
    if (videoRef.current && canvasRef.current) {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        setCapturedImage(dataUrl);
      }
    }
  };

  const savePhoto = () => {
    if (capturedImage) {
      const base64 = capturedImage.split(',')[1];
      const now = Date.now();
      const newDoc: AttachedDocument = {
        name: `captured_doc_${now}.jpg`,
        type: 'image/jpeg',
        size: Math.round((base64.length * 3) / 4),
        data: base64,
        uploadedAt: now,
        expiresAt: now + RETENTION_PERIOD_MS,
        annotations: []
      };
      setDocuments(prev => [...prev, newDoc]);
      closeCamera();
    }
  };

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files) handleFiles(e.dataTransfer.files);
  }, []);

  const removeDocument = (uploadedAt: number) => {
    setDocuments((prev) => prev.filter((doc) => doc.uploadedAt !== uploadedAt));
    setSelectedDocTimestamps(prev => {
      const next = new Set(prev);
      next.delete(uploadedAt);
      return next;
    });
  };

  const getBlobFromBase64 = (doc: AttachedDocument): Blob => {
    const binaryString = atob(doc.data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return new Blob([bytes], { type: doc.type });
  };

  const handleDownload = (doc: AttachedDocument) => {
    const blob = getBlobFromBase64(doc);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = doc.name;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleDownloadAll = async () => {
    if (documents.length === 0) return;
    setIsZipping(true);
    try {
      const zip = new JSZip();
      documents.forEach(doc => {
        const binaryString = atob(doc.data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        zip.file(doc.name, bytes);
      });
      const content = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(content);
      const link = document.createElement('a');
      link.href = url;
      link.download = `HERA_Legal_Documents_${new Date().getTime()}.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Failed to create ZIP:', error);
      alert('Could not bundle documents. Please try downloading them individually.');
    } finally {
      setIsZipping(false);
    }
  };

  const toggleSort = (criterion: SortCriterion) => {
    if (sortCriterion === criterion) setSortDirection(prev => (prev === 'asc' ? 'desc' : 'asc'));
    else {
      setSortCriterion(criterion);
      setSortDirection(criterion === 'name' ? 'asc' : 'desc');
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setEmailError('');
    const isFilled = Object.entries(formData).every(([key, value]) => {
      const stringValue = value as string;
      if (key === 'phone') return stringValue.trim() !== '';
      return typeof value === 'string' && stringValue.trim() !== '';
    });
    if (!isFilled) {
      alert('Please fill out all mandatory fields.');
      return;
    }
    if (!EMAIL_REGEX.test(formData.email)) {
      setEmailError('Please enter a valid email address.');
      return;
    }
    const sanitizedPhonePart = formData.phone.trim().replace(/^0+/, '');
    const fullPhoneNumber = `${selectedCountryCode}${sanitizedPhonePart}`;
    onSubmit({ ...formData, phone: fullPhoneNumber, documents: sortedDocuments });
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const getDocDataUrl = (doc: AttachedDocument) => `data:${doc.type};base64,${doc.data}`;
  const isImage = (type: string) => type.startsWith('image/');

  const handleOpenPreview = (doc: AttachedDocument) => {
    setZoom(1);
    setRotation(0);
    setPan({ x: 0, y: 0 });
    setPreviewDoc(doc);
    setPdfSearchQuery('');
    setPdfSearchResults(null);
    setActiveAnnotationId(null);
    setActiveTool(null);
  };

  const handleZoomIn = () => setZoom(prev => Math.min(prev + 0.25, 5));
  const handleZoomOut = () => setZoom(prev => Math.max(prev - 0.25, 0.25));
  const handleRotate = () => setRotation(prev => (prev + 90) % 360);
  const handleReset = () => {
    setZoom(1);
    setRotation(0);
    setPan({ x: 0, y: 0 });
  };

  // Keyboard controls
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!previewDoc) return;
      if (e.key === '=' || e.key === '+') handleZoomIn();
      if (e.key === '-' || e.key === '_') handleZoomOut();
      if (e.key === 'r' || e.key === 'R') handleRotate();
      if (e.key === '0' || e.key === 'f' || e.key === 'F') handleReset();
      if (e.key === 'Escape') {
          if (activeAnnotationId) cancelAnnotationEdit();
          else if (activeTool) setActiveTool(null);
          else setPreviewDoc(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [previewDoc, activeAnnotationId, activeTool, annotationText]);

  return (
    <div className="relative my-4 p-6 bg-gray-800 border border-gray-700 rounded-xl shadow-2xl animate-in fade-in slide-in-from-bottom-4 duration-500">
      
      {/* PDF Parsing Loading State */}
      {isParsing && (
        <div className="absolute inset-0 z-[70] flex items-center justify-center bg-gray-900/80 backdrop-blur-md rounded-xl animate-in fade-in duration-300">
          <div className="flex flex-col items-center gap-4 text-center px-6">
            <div className="relative">
              <div className="w-16 h-16 border-4 border-indigo-500/20 border-t-indigo-500 rounded-full animate-spin"></div>
              <div className="absolute inset-0 flex items-center justify-center">
                <svg className="w-6 h-6 text-indigo-400 animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              </div>
            </div>
            <div className="space-y-1">
              <h3 className="text-lg font-bold text-white tracking-tight">HERA is analyzing your document...</h3>
              <p className="text-xs text-gray-400 font-medium">Extracting client details and legal matter context.</p>
            </div>
          </div>
        </div>
      )}

      {/* Camera Capture Modal */}
      {isCameraOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/90 backdrop-blur-sm animate-in fade-in duration-300">
          <div className="relative max-w-2xl w-full aspect-[3/4] sm:aspect-video bg-gray-900 rounded-3xl overflow-hidden shadow-2xl flex flex-col border border-white/10">
            <div className="flex-grow relative bg-black">
              {!capturedImage ? (
                <video ref={videoRef} autoPlay playsInline className="w-full h-full object-cover" />
              ) : (
                <img src={capturedImage} alt="Captured" className="w-full h-full object-contain" />
              )}
              <canvas ref={canvasRef} className="hidden" />
              <button onClick={closeCamera} className="absolute top-4 right-4 p-2 bg-black/50 text-white rounded-full hover:bg-black/70 transition-colors z-10">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="p-6 bg-gray-900 border-t border-white/5 flex items-center justify-center gap-6">
              {!capturedImage ? (
                <button onClick={capturePhoto} className="w-16 h-16 bg-white rounded-full flex items-center justify-center border-4 border-gray-400 active:scale-90 transition-transform shadow-xl">
                  <div className="w-12 h-12 bg-white rounded-full border-2 border-gray-200" />
                </button>
              ) : (
                <>
                  <button onClick={() => setCapturedImage(null)} className="px-6 py-2.5 bg-gray-800 text-gray-300 font-bold rounded-xl border border-gray-700 hover:bg-gray-700 transition-all active:scale-95">Retake</button>
                  <button onClick={savePhoto} className="px-8 py-2.5 bg-indigo-600 text-white font-bold rounded-xl hover:bg-indigo-500 transition-all active:scale-95 shadow-lg shadow-indigo-600/20">Use Photo</button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Preview Modal */}
      {previewDoc && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/95 backdrop-blur-md animate-in fade-in duration-300" onClick={() => setPreviewDoc(null)}>
          <div className="relative max-w-7xl w-full h-[90vh] flex flex-col bg-gray-900 rounded-3xl overflow-hidden shadow-[0_0_50px_-12px_rgba(0,0,0,0.5)] ring-1 ring-white/10" onClick={(e) => e.stopPropagation()}>
            
            {/* Header with Tools */}
            <div className="flex flex-col md:flex-row md:items-center justify-between p-4 border-b border-white/5 bg-gray-900/80 backdrop-blur-xl flex-shrink-0 z-10 gap-4">
              <div className="flex items-center gap-3 overflow-hidden">
                <div className="p-2.5 bg-indigo-500/10 rounded-xl shadow-inner border border-indigo-500/20">
                   <svg className="w-5 h-5 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                     <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                     <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                   </svg>
                </div>
                <div className="truncate">
                  <h3 className="text-sm font-bold text-gray-100 truncate">{previewDoc.name}</h3>
                  <p className="text-[10px] text-gray-500 uppercase tracking-[0.2em] font-black">AI Document Analyzer</p>
                </div>
              </div>

              {/* PDF Search UI */}
              {previewDoc.type === 'application/pdf' && (
                <div className="flex-grow max-w-md mx-4">
                  <div className="relative group">
                    <input type="text" placeholder="Ask HERA to find text in PDF..." value={pdfSearchQuery} onChange={(e) => setPdfSearchQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handlePdfSearch()} className="w-full bg-black/40 border border-white/10 text-white rounded-xl pl-9 pr-20 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500/50 transition-all placeholder:text-gray-600" />
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                      <svg className="w-3.5 h-3.5 text-gray-500 group-focus-within:text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                    </div>
                    <button onClick={handlePdfSearch} disabled={isSearchingInPdf || !pdfSearchQuery.trim()} className="absolute inset-y-1 right-1 px-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-[10px] font-black uppercase tracking-widest transition-all disabled:opacity-50">{isSearchingInPdf ? 'Scanning...' : 'Search'}</button>
                  </div>
                </div>
              )}

              {/* Action Buttons */}
              <div className="flex items-center gap-1.5 p-1 bg-white/5 rounded-2xl border border-white/10">
                <button onClick={() => handleDownload(previewDoc)} className="p-2 hover:bg-white/5 rounded-full text-indigo-400 hover:text-indigo-300 transition-all active:scale-95" title="Download"><svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg></button>
                <button onClick={() => setPreviewDoc(null)} className="p-2 hover:bg-white/5 rounded-full text-gray-500 hover:text-white transition-all"><svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg></button>
              </div>
            </div>
            
            <div className="flex-grow flex flex-col md:flex-row overflow-hidden relative">
              
              {/* Floating Vertical Annotation Toolbar */}
              <div className="absolute top-1/2 -translate-y-1/2 left-6 z-40 flex flex-col gap-3 p-2 bg-gray-900/90 backdrop-blur-2xl border border-white/10 rounded-2xl shadow-2xl ring-1 ring-white/5">
                <div className="px-2 py-1 mb-1 border-b border-white/10">
                   <p className="text-[8px] font-black text-gray-500 uppercase tracking-tighter text-center">Tools</p>
                </div>
                <button 
                  onClick={() => setActiveTool(activeTool === 'pin' ? null : 'pin')} 
                  className={`p-3 rounded-xl transition-all relative group ${activeTool === 'pin' ? 'bg-indigo-600 text-white shadow-[0_0_20px_rgba(99,102,241,0.5)] scale-110' : 'text-gray-400 hover:bg-white/5 hover:text-white'}`}
                >
                  <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7z" clipRule="evenodd" /></svg>
                  <span className="absolute left-full ml-4 px-2 py-1 bg-gray-900 text-white text-[10px] font-black uppercase rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap border border-white/10">Add Pin</span>
                </button>
                
                <button 
                  onClick={() => setActiveTool(activeTool === 'rect' ? null : 'rect')} 
                  className={`p-3 rounded-xl transition-all relative group ${activeTool === 'rect' ? 'bg-indigo-600 text-white shadow-[0_0_20px_rgba(99,102,241,0.5)] scale-110' : 'text-gray-400 hover:bg-white/5 hover:text-white'}`}
                >
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" strokeWidth="2.5" rx="2" /></svg>
                  <span className="absolute left-full ml-4 px-2 py-1 bg-gray-900 text-white text-[10px] font-black uppercase rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap border border-white/10">Rectangle Tool</span>
                </button>
                
                <button 
                  onClick={() => setActiveTool(activeTool === 'arrow' ? null : 'arrow')} 
                  className={`p-3 rounded-xl transition-all relative group ${activeTool === 'arrow' ? 'bg-indigo-600 text-white shadow-[0_0_20px_rgba(99,102,241,0.5)] scale-110' : 'text-gray-400 hover:bg-white/5 hover:text-white'}`}
                >
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M17 8l4 4m0 0l-4 4m4-4H3" /></svg>
                  <span className="absolute left-full ml-4 px-2 py-1 bg-gray-900 text-white text-[10px] font-black uppercase rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap border border-white/10">Arrow Tool</span>
                </button>
              </div>

              {/* Left Side: Document Content & Drawing Surface */}
              <div 
                ref={previewContainerRef}
                className={`flex-grow relative flex justify-center items-center overflow-hidden bg-gray-950/50 select-none group/viewer ${activeTool ? 'cursor-crosshair' : (zoom > 1 || rotation !== 0) ? 'cursor-grab' : 'cursor-default'} ${isDraggingImage ? 'cursor-grabbing' : ''}`}
                onMouseDown={handleMouseDownOnDoc}
                onMouseMove={handleMouseMoveOnDoc}
                onMouseUp={handleMouseUpOnDoc}
              >
                <div 
                  ref={docElementRef}
                  className={`transition-transform ${isDraggingImage ? 'duration-0' : 'duration-300'} ease-out origin-center relative`} 
                  style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom}) rotate(${rotation}deg)` }}
                >
                  {isImage(previewDoc.type) ? (
                    <img src={getDocDataUrl(previewDoc)} alt={previewDoc.name} draggable={false} className="max-w-[85vw] max-h-[65vh] rounded-lg shadow-2xl border border-white/5" />
                  ) : previewDoc.type === 'application/pdf' ? (
                    <div className="w-[85vw] max-w-5xl h-[65vh] bg-white rounded-xl overflow-hidden shadow-2xl relative">
                       <iframe src={`${getDocDataUrl(previewDoc)}#toolbar=0&navpanes=0&scrollbar=1`} className="w-full h-full border-none pointer-events-auto" title="PDF Document" />
                       {activeTool && <div className="absolute inset-0 z-10 cursor-crosshair" />}
                    </div>
                  ) : (
                    <div className="text-center p-16 bg-gray-900/50 rounded-3xl border border-white/5 backdrop-blur-md">
                      <h4 className="text-xl font-bold text-gray-100">Limited Preview</h4>
                    </div>
                  )}

                  {/* Render Annotations & Drawing Previews */}
                  <svg className="absolute inset-0 w-full h-full pointer-events-none z-20">
                    <defs>
                      <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="0" refY="3.5" orientation="auto">
                        <polygon points="0 0, 10 3.5, 0 7" fill="#6366f1" />
                      </marker>
                      <marker id="arrowhead-amber" markerWidth="10" markerHeight="7" refX="0" refY="3.5" orientation="auto">
                        <polygon points="0 0, 10 3.5, 0 7" fill="#f59e0b" />
                      </marker>
                    </defs>
                    
                    {isDrawing && currentDraw && activeTool === 'rect' && (
                        <rect x={`${currentDraw.x}%`} y={`${currentDraw.y}%`} width={`${currentDraw.w}%`} height={`${currentDraw.h}%`} fill="rgba(99,102,241,0.1)" stroke="#6366f1" strokeWidth="2" strokeDasharray="4" />
                    )}
                    {isDrawing && currentDraw && activeTool === 'arrow' && (
                        <line x1={`${currentDraw.x}%`} y1={`${currentDraw.y}%`} x2={`${currentDraw.ex}%`} y2={`${currentDraw.ey}%`} stroke="#6366f1" strokeWidth="3" markerEnd="url(#arrowhead)" />
                    )}

                    {(previewDoc.annotations || []).map(ann => {
                        if (ann.type === 'rect' && ann.width && ann.height) {
                            return <rect key={ann.id} x={`${ann.x}%`} y={`${ann.y}%`} width={`${ann.width}%`} height={`${ann.height}%`} fill="rgba(245,158,11,0.1)" stroke="#f59e0b" strokeWidth="2" className="cursor-pointer pointer-events-auto" onClick={(e) => { e.stopPropagation(); selectAnnotation(ann); }} />;
                        }
                        if (ann.type === 'arrow' && ann.endX !== undefined && ann.endY !== undefined) {
                            return <line key={ann.id} x1={`${ann.x}%`} y1={`${ann.y}%`} x2={`${ann.endX}%`} y2={`${ann.endY}%`} stroke="#f59e0b" strokeWidth="3" markerEnd="url(#arrowhead-amber)" className="cursor-pointer pointer-events-auto" onClick={(e) => { e.stopPropagation(); selectAnnotation(ann); }} />;
                        }
                        return null;
                    })}
                  </svg>
                  
                  {(previewDoc.annotations || []).filter(a => a.type === 'pin').map(ann => (
                    <button key={ann.id} onClick={(e) => { e.stopPropagation(); selectAnnotation(ann); }} className={`absolute z-20 w-8 h-8 -ml-4 -mt-4 rounded-full flex items-center justify-center text-white text-[10px] font-bold shadow-xl transition-all transform hover:scale-125 border-2 ${activeAnnotationId === ann.id ? 'bg-indigo-500 scale-125 border-white ring-4 ring-indigo-500/20' : 'bg-amber-500 border-amber-300'}`} style={{ left: `${ann.x}%`, top: `${ann.y}%` }}>
                      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7z" clipRule="evenodd" /></svg>
                    </button>
                  ))}
                </div>

                {/* Refined PDF Preview Toolbar */}
                <div className={`absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-1.5 p-2 bg-gray-900/95 backdrop-blur-2xl border border-white/20 rounded-2xl shadow-2xl transition-all duration-300 z-30 ring-1 ring-white/10 ${activeAnnotationId ? 'scale-105 ring-2 ring-indigo-500/40' : ''}`}>
                  <button onClick={handleZoomOut} className="p-2.5 text-gray-400 hover:text-white hover:bg-white/5 rounded-xl transition-all active:scale-90" title="Zoom Out (-)"><svg className="w-4.5 h-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M20 12H4" /></svg></button>
                  <span className="px-3 text-[11px] font-black text-indigo-400 min-w-[55px] text-center tabular-nums">{Math.round(zoom * 100)}%</span>
                  <button onClick={handleZoomIn} className="p-2.5 text-gray-400 hover:text-white hover:bg-white/5 rounded-xl transition-all active:scale-90" title="Zoom In (+)"><svg className="w-4.5 h-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M12 4v16m8-8H4" /></svg></button>
                  <div className="w-px h-6 bg-white/10 mx-1.5"></div>
                  <button onClick={handleRotate} className="p-2.5 text-gray-400 hover:text-white hover:bg-white/5 rounded-xl transition-all active:scale-90" title="Rotate 90° (R)"><svg className="w-4.5 h-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357-2H15" /></svg></button>
                  <button onClick={handleReset} className="px-4 py-2 text-indigo-400 hover:bg-indigo-400/10 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all" title="Reset View (F / 0)">Fit</button>
                  
                  {activeAnnotationId && (
                    <>
                      <div className="w-px h-6 bg-white/10 mx-1.5"></div>
                      <button 
                        onClick={saveAnnotationText}
                        className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center gap-2 shadow-lg shadow-indigo-600/20"
                        title="Save Changes"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M5 13l4 4L19 7" />
                        </svg>
                        Save & Close
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* Right Side: Observations Panel */}
              <div className="w-full md:w-80 border-l border-white/5 bg-gray-900/50 flex flex-col overflow-hidden">
                {pdfSearchResults && (
                  <div className="p-4 border-b border-white/5 bg-indigo-600/5 animate-in slide-in-from-right duration-300">
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="text-[10px] font-black text-indigo-400 uppercase tracking-widest">Search Insights</h4>
                      <button onClick={() => setPdfSearchResults(null)} className="text-gray-500 hover:text-white"><svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg></button>
                    </div>
                    <p className="text-xs text-gray-300 leading-relaxed italic">"{pdfSearchResults}"</p>
                  </div>
                )}

                <div className="flex-grow overflow-y-auto p-4 space-y-4">
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="text-[10px] font-black text-gray-400 uppercase tracking-[0.2em]">Observations</h4>
                  </div>
                  
                  {activeAnnotationId && (
                    <div className="bg-gray-800 rounded-2xl border border-indigo-500/30 p-4 shadow-xl animate-in zoom-in-95 mb-4">
                      <div className="flex items-center gap-2 mb-3">
                         <div className="w-6 h-6 bg-indigo-500 rounded-full flex items-center justify-center text-[10px] font-black leading-none text-white italic">!</div>
                         <span className="text-[10px] font-black text-gray-300 uppercase tracking-wider">Comment Detail</span>
                      </div>
                      <textarea autoFocus value={annotationText} onChange={(e) => setAnnotationText(e.target.value)} placeholder="Type description or legal note..." className="w-full bg-black/40 border border-white/10 text-white rounded-xl p-3 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-all placeholder:text-gray-600 mb-3" rows={3} />
                      <div className="flex items-center justify-between gap-2">
                        <button onClick={() => deleteAnnotation(activeAnnotationId)} className="px-3 py-1.5 text-red-400 hover:bg-red-400/10 rounded-lg text-[10px] font-black uppercase transition-all">Remove</button>
                        <div className="flex gap-2">
                          <button onClick={cancelAnnotationEdit} className="px-3 py-1.5 text-gray-400 hover:text-white rounded-lg text-[10px] font-black uppercase transition-all">Cancel</button>
                          <button onClick={saveAnnotationText} className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-[10px] font-black uppercase tracking-widest transition-all">Save</button>
                        </div>
                      </div>
                    </div>
                  )}

                  {(previewDoc.annotations || []).length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-12 text-center opacity-60">
                       <div className="w-12 h-12 bg-white/5 rounded-2xl flex items-center justify-center mb-4 border border-white/5">
                         <svg className="w-6 h-6 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                       </div>
                       <p className="text-[10px] text-gray-500 font-black uppercase tracking-widest">No Marks on Record</p>
                       <p className="text-[9px] text-gray-600 mt-2 px-6">Select a tool from the left sidebar to highlight sections of this document.</p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {(previewDoc.annotations || []).map(ann => {
                        const isCollapsed = collapsedAnnotations.has(ann.id);
                        const isActive = activeAnnotationId === ann.id;
                        return (
                          <div key={ann.id} className={`rounded-xl border transition-all ${isActive ? 'border-indigo-500 bg-indigo-500/10 ring-2 ring-indigo-500/20' : 'border-white/5 bg-black/20 hover:border-white/10'}`}>
                            <div className="flex items-center justify-between p-3 cursor-pointer group" onClick={() => toggleAnnotationCollapse(ann.id)}>
                              <div className="flex items-center gap-2 overflow-hidden">
                                <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${ann.type === 'pin' ? 'bg-amber-500' : ann.type === 'rect' ? 'bg-indigo-400' : 'bg-red-400'}`} />
                                <span className="text-[9px] font-black text-gray-300 uppercase truncate">{ann.type} mark by {ann.author}</span>
                              </div>
                              <div className="flex items-center gap-2">
                                <button onClick={(e) => { e.stopPropagation(); selectAnnotation(ann); }} className="text-gray-500 hover:text-white transition-colors" title="Edit Mark"><svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg></button>
                                <svg className={`w-3 h-3 text-gray-600 transition-transform duration-300 ${isCollapsed ? '' : 'rotate-180'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M19 9l-7 7-7-7" /></svg>
                              </div>
                            </div>
                            {!isCollapsed && (
                              <div className="px-3 pb-3 animate-in slide-in-from-top-1 duration-200">
                                <p className="text-xs text-gray-400 leading-relaxed italic border-t border-white/5 pt-2">{ann.text || <span className="text-gray-600">No descriptive text added...</span>}</p>
                                <div className="mt-2 flex items-center justify-between">
                                  <span className="text-[8px] text-gray-600 font-bold uppercase tracking-tighter">{new Date(ann.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                                  <button onClick={(e) => { e.stopPropagation(); deleteAnnotation(ann.id); }} className="text-[8px] text-red-500/50 hover:text-red-500 font-black uppercase tracking-widest">Delete</button>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="p-4 bg-black/20 border-t border-white/5 text-center">
                   <p className="text-[9px] text-gray-500 font-bold uppercase tracking-wider mb-1">Session Protocol: Sync Active</p>
                   <p className="text-[8px] text-gray-600 leading-tight">All visual markers will be included in your secure intake packet.</p>
                </div>
              </div>
            </div>
            
            <div className="p-4 bg-gray-900 border-t border-white/5 flex items-center justify-between flex-shrink-0">
               <div className="flex items-center gap-2">
                 <div className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse"></div>
                 <p className="text-[10px] text-gray-500 font-bold uppercase tracking-[0.2em]">AES-256 Encrypted Viewer Session</p>
               </div>
               <button onClick={() => setPreviewDoc(null)} className="px-6 py-2 bg-indigo-600/10 text-indigo-400 hover:bg-indigo-600 hover:text-white text-[10px] font-black uppercase tracking-widest rounded-xl transition-all">Close Analyzer</button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between gap-3 mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-indigo-600/20 rounded-lg"><svg className="w-5 h-5 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg></div>
          <div>
            <h2 className="text-xl font-bold text-gray-100">Client Intake & Secure Portal</h2>
            <p className="text-xs text-gray-500 uppercase tracking-widest font-bold">Secure Case Submission</p>
          </div>
        </div>
        <div className="flex-shrink-0">
          <input type="file" ref={pdfParseInputRef} onChange={handlePdfAutoFill} accept="application/pdf" className="hidden" />
          <button type="button" onClick={() => pdfParseInputRef.current?.click()} className="group flex items-center gap-2 px-4 py-2 border border-indigo-500/50 text-indigo-400 hover:bg-indigo-500 hover:text-white rounded-xl text-xs font-black transition-all shadow-lg shadow-indigo-500/10 active:scale-95 whitespace-nowrap">
            <svg className="w-4 h-4 group-hover:rotate-12 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-7.714 2.143L11 21l-2.143-7.714L1 12l6.857-2.143L11 3z" /></svg>
            Auto-fill from PDF
          </button>
        </div>
      </div>
      
      <p className="text-sm text-gray-400 mb-6 leading-relaxed">Please provide your details and upload any relevant legal documents. You can also use the <span className="text-indigo-400 font-bold italic">Auto-fill</span> feature to extract information from an existing legal form.</p>
      
      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label htmlFor="fullName" className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-1.5">Full Name</label>
            <input type="text" id="fullName" name="fullName" placeholder="e.g. John Doe" value={formData.fullName} onChange={handleChange} className="w-full bg-gray-900 border border-gray-700 text-white rounded-lg px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all placeholder:text-gray-600 shadow-inner" required />
          </div>
          <div>
            <label htmlFor="phone" className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-1.5">Phone Number</label>
            <div className="flex gap-2">
              <select value={selectedCountryCode} onChange={(e) => setSelectedCountryCode(e.target.value)} className="bg-gray-900 border border-gray-700 text-white rounded-lg px-2 py-2.5 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all cursor-pointer w-28 shrink-0 text-xs font-bold shadow-inner">
                {COUNTRY_CODES.map(c => <option key={c.code} value={c.code} className="bg-gray-900">{c.label} ({c.code})</option>)}
              </select>
              <input type="tel" id="phone" name="phone" placeholder="712 345 678" value={formData.phone} onChange={handleChange} className="flex-grow bg-gray-900 border border-gray-700 text-white rounded-lg px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all placeholder:text-gray-600 shadow-inner" required />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label htmlFor="email" className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-1.5">Email Address</label>
            <input type="email" id="email" name="email" placeholder="john@example.com" value={formData.email} onChange={handleChange} className={`w-full bg-gray-900 border text-white rounded-lg px-4 py-2.5 focus:outline-none transition-all placeholder:text-gray-600 shadow-inner ${emailError ? 'border-red-500 focus:ring-2 focus:ring-red-500' : 'border-gray-700 focus:ring-2 focus:ring-indigo-500'}`} required />
            {emailError && <p className="text-red-400 text-[10px] mt-1 font-bold uppercase tracking-wider animate-in fade-in slide-in-from-top-1">{emailError}</p>}
          </div>
          <div>
            <label htmlFor="caseType" className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-1.5">Legal Matter Category</label>
            <select id="caseType" name="caseType" value={formData.caseType} onChange={handleChange} className="w-full bg-gray-900 border border-gray-700 text-white rounded-lg px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all appearance-none cursor-pointer shadow-inner" required>
              <option value="" disabled>Select category...</option>
              {CASE_TYPES.map(type => <option key={type} value={type}>{type}</option>)}
            </select>
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label htmlFor="caseDetails" className="block text-xs font-bold text-gray-400 uppercase tracking-wider">Brief Case Details</label>
            {recognitionRef.current && (
              <button type="button" onClick={handleToggleVoiceDetails} className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider transition-all ${isListeningDetails ? 'bg-red-500/20 text-red-400 ring-1 ring-red-500/50 animate-pulse' : 'bg-gray-700 text-gray-300 hover:bg-gray-600 hover:text-white ring-1 ring-gray-600 shadow-sm'}`}>
                <MicrophoneIcon className={`w-3 h-3 ${isListeningDetails ? 'animate-bounce' : ''}`} />
                {isListeningDetails ? 'Listening...' : 'Dictate'}
              </button>
            )}
          </div>
          <textarea id="caseDetails" name="caseDetails" value={formData.caseDetails} onChange={handleChange} rows={3} placeholder={isListeningDetails ? "Speak clearly now..." : "Describe your legal matter briefly..."} className={`w-full bg-gray-900 border text-white rounded-lg px-4 py-2.5 focus:outline-none focus:ring-2 transition-all placeholder:text-gray-600 resize-none shadow-inner ${isListeningDetails ? 'border-red-500/50 ring-2 ring-red-500/20' : 'border-gray-700 focus:ring-indigo-500'}`} required />
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider">Supporting Documents (Optional)</label>
            <button type="button" onClick={openCamera} className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600/10 text-indigo-400 hover:bg-indigo-600 hover:text-white rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all border border-indigo-600/20 active:scale-95">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
              Take Photo
            </button>
          </div>
          <div className="mb-3 px-3 py-2 bg-indigo-500/5 border border-indigo-500/10 rounded-lg flex items-center gap-2.5">
            <svg className="w-4 h-4 text-indigo-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            <p className="text-[11px] text-gray-400 leading-tight"><span className="text-indigo-300 font-bold uppercase tracking-tighter mr-1">Guidelines:</span>Accepted formats are <span className="text-gray-200">PDF, Word (.docx), and Images (.jpg)</span>. Max size <span className="text-gray-200 text-sm">10MB</span>.</p>
          </div>
          <div onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop} onClick={() => fileInputRef.current?.click()} className={`border-2 border-dashed rounded-xl p-8 flex flex-col items-center justify-center transition-all duration-300 cursor-pointer group relative overflow-hidden ${isDragging ? 'border-indigo-500 bg-indigo-500/10 scale-[1.02] shadow-[0_0_25px_-5px_rgba(99,102,241,0.4)]' : 'border-gray-700 bg-gray-900/50 hover:bg-gray-900 hover:border-indigo-500/50'}`}>
            {isDragging && <div className="absolute inset-0 border-2 border-indigo-400 rounded-xl animate-pulse pointer-events-none shadow-[inset_0_0_20px_rgba(99,102,241,0.2)]" />}
            <input type="file" ref={fileInputRef} onChange={handleFileChange} multiple accept=".pdf,.docx,.jpg,.jpeg" className="hidden" />
            <div className={`transform transition-all duration-300 ${isDragging ? 'scale-110 -translate-y-1' : ''}`}><svg className={`w-12 h-12 mb-4 transition-colors ${isDragging ? 'text-indigo-400' : 'text-gray-500 group-hover:text-indigo-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" /></svg></div>
            <p className={`text-sm font-bold transition-colors duration-300 mb-1 ${isDragging ? 'text-indigo-400' : 'text-gray-200'}`}>{isDragging ? 'Drop Files to Upload' : 'Click or drag files here'}</p>
          </div>

          {uploadingFiles.length > 0 && (
            <div className="mt-4 space-y-3">
              <h4 className="text-[10px] font-bold text-indigo-400 uppercase tracking-widest flex items-center gap-2"><span className="w-1.5 h-1.5 bg-indigo-500 rounded-full animate-ping" />Processing Documents...</h4>
              {uploadingFiles.map(file => (
                <div key={file.id} className="bg-gray-900 border border-gray-700 rounded-lg p-3 animate-in slide-in-from-top-2">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-gray-300 truncate font-medium max-w-[200px]">{file.name}</span>
                    <span className="text-[10px] font-bold text-gray-500">{file.progress}%</span>
                  </div>
                  <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden"><div className="h-full bg-indigo-600 transition-all duration-300 rounded-full shadow-[0_0_8px_rgba(79,70,229,0.5)]" style={{ width: `${file.progress}%` }} /></div>
                </div>
              ))}
            </div>
          )}

          {fileErrors.length > 0 && (
            <div className="mt-3 space-y-2">
              {fileErrors.map((err, i) => (
                <div key={i} className="text-[11px] text-red-400 bg-red-400/10 border border-red-400/20 px-4 py-2.5 rounded-xl flex items-start gap-2.5 animate-in slide-in-from-top-1 shadow-sm"><svg className="w-4 h-4 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg><span className="font-medium leading-tight">{err}</span></div>
              ))}
            </div>
          )}

          {documents.length > 0 && (
            <div className="mt-6 relative">
              <div className="space-y-4 mb-4 pb-2 border-b border-gray-700/50">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <h4 className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Uploaded Documents ({documents.length})</h4>
                    <div className="flex gap-2">
                      <button type="button" onClick={() => setIsBulkMode(!isBulkMode)} className={`text-[10px] px-3 py-1.5 rounded-lg border transition-all font-bold uppercase tracking-tight flex items-center gap-2 active:scale-95 ${isBulkMode ? 'bg-indigo-600 border-indigo-500 text-white shadow-lg shadow-indigo-600/30' : 'bg-gray-800 border-gray-700 text-gray-300 hover:border-indigo-500 hover:text-indigo-400'}`}>
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg>
                        {isBulkMode ? 'Exit Bulk Mode' : 'Bulk Action'}
                      </button>
                      {isBulkMode && (
                        <button type="button" onClick={handleSelectAll} className="text-[10px] px-3 py-1.5 rounded-lg bg-gray-700 border border-gray-600 text-white hover:bg-gray-600 transition-all font-bold uppercase tracking-tight active:scale-95">
                          {selectedDocTimestamps.size === sortedDocuments.length ? 'Deselect All' : 'Select All'}
                        </button>
                      )}
                      {documents.length > 1 && !isBulkMode && (
                        <button type="button" onClick={handleDownloadAll} disabled={isZipping} className="text-[10px] px-3 py-1.5 rounded-lg bg-indigo-600/10 border border-indigo-600/20 hover:bg-indigo-600 text-indigo-400 hover:text-white transition-all font-bold uppercase tracking-tight flex items-center gap-2 shadow-lg shadow-indigo-600/20 disabled:opacity-50 active:scale-95">{isZipping ? <div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>}ZIP</button>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 overflow-x-auto pb-1 sm:pb-0 scrollbar-hide">
                    <div className="flex items-center text-gray-500 mr-1"><svg className="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12" /></svg><span className="text-[9px] uppercase font-bold tracking-tighter whitespace-nowrap">Order By:</span></div>
                    <div className="flex items-center bg-gray-900/80 p-0.5 rounded-lg ring-1 ring-gray-700/50">
                      {(['name', 'date', 'expiry'] as SortCriterion[]).map((criterion) => (
                        <button key={criterion} type="button" onClick={() => toggleSort(criterion)} aria-label={`Sort by ${criterion}`} className={`text-[9px] px-2.5 py-1.5 rounded-md transition-all font-bold uppercase tracking-tight flex items-center gap-1.5 group/sort-btn ${sortCriterion === criterion ? 'bg-indigo-600 text-white shadow-md' : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800'}`}>{criterion === 'date' ? 'Date' : criterion === 'expiry' ? 'Expiry' : 'Name'}<div className={`flex flex-col items-center justify-center transition-all ${sortCriterion === criterion ? 'opacity-100' : 'opacity-0 group-hover/sort-btn:opacity-40'}`}><svg className={`w-2.5 h-2.5 transition-transform duration-300 ${sortCriterion === criterion && sortDirection === 'desc' ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M5 15l7-7 7 7" /></svg></div></button>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="relative group">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none"><svg className="h-3.5 w-3.5 text-gray-500 group-focus-within:text-indigo-400 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg></div>
                  <input type="text" placeholder="Search documents by name..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className="w-full bg-gray-900/50 border border-gray-700/50 text-white rounded-xl pl-9 pr-10 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500/50 transition-all placeholder:text-gray-600" />
                  {searchTerm && <button type="button" onClick={() => setSearchTerm('')} className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-500 hover:text-white transition-colors"><svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg></button>}
                </div>
              </div>

              {isBulkMode && selectedDocTimestamps.size > 0 && (
                <div className="sticky top-0 z-20 mb-4 p-4 bg-indigo-900/90 backdrop-blur-md border border-indigo-500/50 rounded-2xl shadow-2xl flex flex-col md:flex-row items-center gap-4 animate-in slide-in-from-top-4 duration-300">
                  <div className="flex-shrink-0 flex items-center gap-3">
                    <div className="w-10 h-10 bg-indigo-500 rounded-full flex items-center justify-center text-white font-black text-sm shadow-lg shadow-indigo-500/30">{selectedDocTimestamps.size}</div>
                    <div className="flex flex-col">
                      <p className="text-[10px] font-black text-white uppercase tracking-widest leading-none">Docs Selected</p>
                      <button onClick={handleSelectAll} className="text-[8px] text-indigo-200 hover:text-white font-bold uppercase tracking-tighter text-left mt-0.5">Toggle All</button>
                    </div>
                  </div>
                  <div className="flex-grow w-full relative">
                    <input type="text" placeholder="Add comment/tag to selected files..." value={bulkAnnotationText} onChange={(e) => setBulkAnnotationText(e.target.value)} className="w-full bg-black/40 border border-white/20 text-white rounded-xl px-4 py-2.5 text-xs focus:outline-none focus:ring-2 focus:ring-white/30 transition-all placeholder:text-gray-400" />
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button type="button" onClick={() => { setSelectedDocTimestamps(new Set()); setIsBulkMode(false); }} className="px-4 py-2 text-indigo-200 hover:text-white text-[10px] font-black uppercase tracking-widest transition-all">Cancel</button>
                    <button type="button" onClick={applyBulkAnnotation} disabled={!bulkAnnotationText.trim() || isApplyingBulk} className="px-6 py-2.5 bg-white text-indigo-900 font-black rounded-xl text-[10px] uppercase tracking-widest hover:bg-indigo-50 transition-all disabled:opacity-50 shadow-xl">{isApplyingBulk ? 'Applying...' : 'Apply to All'}</button>
                  </div>
                </div>
              )}
              
              {sortedDocuments.length > 0 ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {sortedDocuments.map((doc) => {
                    const isSelected = selectedDocTimestamps.has(doc.uploadedAt);
                    return (
                      <div key={doc.uploadedAt} onClick={() => isBulkMode && handleBulkToggle(doc.uploadedAt)} className={`flex flex-col bg-gray-900 rounded-lg border overflow-hidden animate-in fade-in slide-in-from-left-2 group shadow-sm transition-all cursor-pointer ${isBulkMode && isSelected ? 'border-indigo-500 bg-indigo-500/10 ring-2 ring-indigo-500/20' : isBulkMode ? 'border-gray-700 hover:border-indigo-500/50' : 'border-gray-700 hover:shadow-indigo-500/10'}`}>
                        <div className="flex items-center p-3 relative">
                          {isBulkMode && (
                            <div className={`absolute top-2 right-2 w-5 h-5 rounded flex items-center justify-center border transition-all ${isSelected ? 'bg-indigo-500 border-indigo-500 shadow-sm' : 'bg-gray-800 border-gray-600'}`}>
                              {isSelected && <svg className="w-3.5 h-3.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M5 13l4 4L19 7" /></svg>}
                            </div>
                          )}
                          <div className="flex-shrink-0 w-10 h-10 rounded bg-gray-800 flex items-center justify-center overflow-hidden mr-3 border border-gray-700">
                            {isImage(doc.type) ? <img src={getDocDataUrl(doc)} alt="Thumbnail" className="w-full h-full object-cover" /> : <svg className="w-6 h-6 text-indigo-500" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A1 1 0 0111 2.414l4.172 4.172a1 1 0 01.293.707V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clipRule="evenodd" /></svg>}
                          </div>
                          <div className="flex-grow min-w-0 mr-2">
                            <p className={`text-sm truncate font-medium ${isSelected ? 'text-indigo-300' : 'text-gray-200'}`}>{doc.name}</p>
                            <div className="flex flex-col mt-0.5"><p className="text-[9px] text-gray-500 uppercase font-bold tracking-tight">{formatFileSize(doc.size)} • {sortCriterion === 'expiry' ? `Expires: ${new Date(doc.expiresAt).toLocaleDateString()}` : `Added: ${new Date(doc.uploadedAt).toLocaleDateString()}`}</p></div>
                          </div>
                          {!isBulkMode && (
                            <div className="flex items-center gap-1.5 shrink-0">
                              <button type="button" onClick={(e) => { e.stopPropagation(); handleOpenPreview(doc); }} className="p-1.5 text-gray-400 hover:text-indigo-400 hover:bg-indigo-400/10 rounded-md transition-all" title="Review Document"><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg></button>
                              <button type="button" onClick={(e) => { e.stopPropagation(); handleDownload(doc); }} className="p-1.5 text-indigo-400 hover:text-indigo-300 hover:bg-indigo-400/10 rounded-md transition-all" title="Download"><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg></button>
                              <button type="button" onClick={(e) => { e.stopPropagation(); removeDocument(doc.uploadedAt); }} className="p-1.5 text-gray-400 hover:text-red-400 hover:bg-red-400/10 rounded-md transition-all" title="Remove"><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg></button>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="py-12 flex flex-col items-center justify-center bg-gray-900/30 rounded-2xl border border-dashed border-gray-700/50"><svg className="w-10 h-10 text-gray-600 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg><p className="text-sm font-bold text-gray-500 uppercase tracking-widest">No matching documents found</p></div>
              )}
            </div>
          )}
        </div>

        <div className="bg-blue-900/10 border border-blue-800/20 rounded-lg p-3 flex items-start gap-3">
            <svg className="w-5 h-5 text-blue-400 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
            <p className="text-[11px] leading-tight text-blue-300/80 uppercase tracking-wider font-semibold">Advocate Only Access: Your documents are encrypted and accessible only by Odero & Gitau legal staff.</p>
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onCancel} className="px-5 py-2.5 text-sm font-semibold text-gray-400 hover:text-white transition-colors">Cancel</button>
          <button type="submit" disabled={uploadingFiles.length > 0 || isZipping || isParsing} className="px-6 py-2.5 bg-indigo-600 text-white text-sm font-bold rounded-lg hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-600/20 active:scale-95 disabled:opacity-50 disabled:active:scale-100 disabled:cursor-not-allowed">{uploadingFiles.length > 0 || isParsing ? 'Processing...' : 'Securely Submit'}</button>
        </div>
      </form>
    </div>
  );
};