export enum Sender {
  User = 'user',
  Model = 'model',
}

export interface ChatMessage {
  id: string;
  sender: Sender;
  text: string;
}

export type AnnotationType = 'pin' | 'rect' | 'arrow';

export interface Annotation {
  id: string;
  type: AnnotationType;
  x: number; // percentage from left
  y: number; // percentage from top
  width?: number; // percentage (for rect)
  height?: number; // percentage (for rect)
  endX?: number; // percentage (for arrow)
  endY?: number; // percentage (for arrow)
  text: string;
  author: string;
  createdAt: number;
}

export interface AttachedDocument {
  name: string;
  type: string;
  size: number;
  data: string; // base64
  uploadedAt: number; // timestamp for sorting
  expiresAt: number; // timestamp for retention policy
  annotations?: Annotation[];
}

export interface IntakeFormData {
  fullName: string;
  email: string;
  phone: string;
  caseType: string;
  caseDetails: string;
  documents: AttachedDocument[];
}
