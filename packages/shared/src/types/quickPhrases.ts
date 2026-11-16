export type QuickPhrase = {
  id: string;
  title: string;
  content: string;
  sortOrder: number;
  version: number;
  createdAt: number;
  updatedAt: number;
};

export type QuickPhraseCollection = {
  revision: number;
  items: QuickPhrase[];
};

export type CreateQuickPhraseRequest = {
  clientRequestId: string;
  title: string;
  content: string;
};

export type UpdateQuickPhraseRequest = {
  title: string;
  content: string;
  version: number;
};

export type DeleteQuickPhraseRequest = { version: number };
export type ReorderQuickPhrasesRequest = { revision: number; ids: string[] };
