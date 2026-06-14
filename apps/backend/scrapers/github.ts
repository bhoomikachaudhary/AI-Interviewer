type GitHubRepo = {
  name: string;
  full_name: string;
  description: string | null;
  stargazers_count: number;
};

type ScrapedRepo = {
  name: string;
  fullName: string;
  description: string | null;
  starCount: number;
};

export async function scrapeGithub(username: string): Promise<ScrapedRepo[]> {
  try {
    const proxyUrl = process.env.PROXY_URL;

    const fetchOptions: RequestInit & { proxy?: string } = {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "ai-interviewer-app",
      },
    };

    // Add proxy support if available
    if (proxyUrl) {
      fetchOptions.proxy = proxyUrl;
    }

    const response = await fetch(
      `https://api.github.com/users/${username}/repos`,
      fetchOptions
    );

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.statusText}`);
    }

    const data: GitHubRepo[] = await response.json();

    return data.map((repo) => ({
      name: repo.name,
      fullName: repo.full_name,
      description: repo.description,
      starCount: repo.stargazers_count,
    }));
  } catch (error: any) {
    console.error("GitHub scraping error:", error?.message || error);
    return [];
  }
}