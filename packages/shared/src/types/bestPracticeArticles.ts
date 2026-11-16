

export type PublicBestPracticeArticleSummary = {
  slug: string;
  title: string;
  summary: string;
  publishedAt: number;
  updatedAt: number;
};

export type PublicBestPracticeArticleDetail = PublicBestPracticeArticleSummary & {
  bodyMarkdown: string;
};

export type PublicBestPracticeArticleListResponseBody = {
  items: PublicBestPracticeArticleSummary[];
  total: number;
  offset: number;
  limit: number;
};

export type PublicBestPracticeArticleDetailResponseBody = {
  article: PublicBestPracticeArticleDetail;
};
