import "dotenv/config";
import { PreInterviewBody } from "./types";
import { scrapeGithub } from "./scrapers/github";
import { prisma } from "./db";
import { initSideband } from "./sideband";
import { calculateResult } from "./result";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENAI_KEY = process.env.OPENAI_KEY;

if (!GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY is missing in .env");
}

if (!OPENAI_KEY) {
  throw new Error("OPENAI_KEY is missing in .env");
}

// Helper to parse JSON from request
const parseJSON = async (req: Request) => {
  try {
    return await req.json();
  } catch {
    return null;
  }
};

// Helper to handle CORS
const cors = (): Record<string, string> => ({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
})


Bun.serve({
  port: 3001,
  async fetch(req: Request) {
    const url = new URL(req.url);
    const pathname = url.pathname;

    // OPTIONS for CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: cors() });
    }

    // PRE INTERVIEW
    if (pathname === "/api/v1/pre-interview" && req.method === "POST") {
      try {
        const body = await parseJSON(req);

        if (!body) {
          return new Response(JSON.stringify({ message: "Invalid body" }), {
            status: 400,
            headers: { ...cors(), "Content-Type": "application/json" },
          });
        }

        const parsed = PreInterviewBody.safeParse(body);

        if (!parsed.success) {
          return new Response(
            JSON.stringify({
              message: "Incorrect body",
            }),
            {
              status: 400,
              headers: { ...cors(), "Content-Type": "application/json" },
            }
          );
        }

        const data = parsed.data;

        // Clean GitHub URL
        const githubUrl = data.github.endsWith("/")
          ? data.github.slice(0, -1)
          : data.github;

        const githubUsername = githubUrl.split("/").pop();

        if (!githubUsername) {
          return new Response(
            JSON.stringify({
              message: "Invalid GitHub URL",
            }),
            {
              status: 400,
              headers: { ...cors(), "Content-Type": "application/json" },
            }
          );
        }

        // Scrape GitHub
        const githubData = await scrapeGithub(githubUsername);

        // Store interview
        const interview = await prisma.interview.create({
          data: {
            githubMetadata: JSON.stringify(githubData),
            status: "Pre",
          },
        });

        return new Response(JSON.stringify({ id: interview.id }), {
          headers: { ...cors(), "Content-Type": "application/json" },
        });
      } catch (err) {
        console.error("Pre-interview error:", err);
        return new Response(
          JSON.stringify({ message: "Internal server error" }),
          {
            status: 500,
            headers: { ...cors(), "Content-Type": "application/json" },
          }
        );
      }
    }

    // REALTIME SESSION
    if (pathname.match(/^\/api\/v1\/session\/[^/]+$/) && req.method === "POST") {
      try {
        const interviewId = pathname.split("/").pop();
        const sessionConfig = JSON.stringify({
          type: "realtime",
          model: "gpt-realtime",
          audio: {
            output: { voice: "marin" },
          },
        });

        const body = await req.text();
        const fd = new FormData();
        fd.set("sdp", body || "");
        fd.set("session", sessionConfig);

        const sdpResponse = await fetch(
          "https://api.openai.com/v1/realtime/calls",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${process.env.OPENAI_KEY}`,
              "OpenAI-Safety-Identifier": "hashed-user-id",
            },
            body: fd,
          }
        );

        if (!sdpResponse.ok) {
          const errText = await sdpResponse.text();
          throw new Error(`OpenAI error: ${errText}`);
        }

        const location = sdpResponse.headers.get("Location");
        const callId = location?.split("/").pop();

        console.log("Call ID:", callId);

        const sdp = await sdpResponse.text();

        if (callId && interviewId) {
          initSideband(callId, interviewId);
        }

        return new Response(sdp, {
          headers: { ...cors(), "Content-Type": "application/sdp" },
        });
      } catch (error) {
        console.error("Session error:", error);
        return new Response(JSON.stringify({ error: "Failed to create session" }), {
          status: 500,
          headers: { ...cors(), "Content-Type": "application/json" },
        });
      }
    }

    // USER MESSAGE SAVE
    if (
      pathname.match(/^\/api\/v1\/session\/user\/response\/[^/]+$/) &&
      req.method === "POST"
    ) {
      try {
        const interviewId = pathname.split("/").pop();
        const body = await parseJSON(req);

        if (!body || !body.message) {
          return new Response(
            JSON.stringify({ message: "Message required" }),
            {
              status: 400,
              headers: { ...cors(), "Content-Type": "application/json" },
            }
          );
        }

        await prisma.message.create({
          data: {
            interviewId: interviewId!,
            type: "User",
            message: body.message,
          },
        });

        return new Response(JSON.stringify({ message: "Message saved" }), {
          headers: { ...cors(), "Content-Type": "application/json" },
        });
      } catch (err) {
        console.error("Message save error:", err);
        return new Response(
          JSON.stringify({ message: "Error saving message" }),
          {
            status: 500,
            headers: { ...cors(), "Content-Type": "application/json" },
          }
        );
      }
    }

    // RESULT
    if (pathname.match(/^\/api\/v1\/result\/[^/]+$/) && req.method === "GET") {
      try {
        const interviewId = pathname.split("/").pop();

        const interview = await prisma.interview.findFirst({
          where: {
            id: interviewId,
          },
          include: {
            conversations: true,
          },
        });

        if (!interview) {
          return new Response(
            JSON.stringify({
              message: "Interview not found",
            }),
            {
              status: 404,
              headers: { ...cors(), "Content-Type": "application/json" },
            }
          );
        }

        const response = {
          score: interview.score,
          feedback: interview.feedback,
          transcript: interview.conversations.map((c) => ({
            type: c.type,
            content: c.message,
            createdAt: c.createdAt,
          })),
          status: interview.status,
        };

        // async evaluation (non-blocking)
        if (interview.status !== "Done") {
          (async () => {
            try {
              const result = await calculateResult(interview.conversations);

              await prisma.interview.update({
                where: {
                  id: interviewId,
                },
                data: {
                  status: "Done",
                  feedback: result.feedback,
                  score: result.score,
                },
              });
            } catch (err) {
              console.error("Result calculation error:", err);
            }
          })();
        }

        return new Response(JSON.stringify(response), {
          headers: { ...cors(), "Content-Type": "application/json" },
        });
      } catch (err) {
        console.error("Result error:", err);
        return new Response(
          JSON.stringify({ message: "Error fetching result" }),
          {
            status: 500,
            headers: { ...cors(), "Content-Type": "application/json" },
          }
        );
      }
    }

    // 404
    return new Response(JSON.stringify({ message: "Not found" }), {
      status: 404,
      headers: { ...cors(), "Content-Type": "application/json" },
    });
  },
});

console.log("Server running on http://localhost:3001");