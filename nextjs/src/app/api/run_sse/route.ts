// https://cloud.google.com/vertex-ai/generative-ai/docs/agent-engine/use/overview#requests_3
// https://cloud.google.com/vertex-ai/generative-ai/docs/agent-engine/use/adk#get-session

import { NextRequest } from "next/server";
import {
  endpointConfig,
  getAgentEngineQueryEndpoint,
  getAgentEngineStreamEndpoint,
  shouldUseAgentEngine,
  getAuthHeaders,
} from "@/lib/config";

// Type definitions for ADK agent response structure
interface ContentPart {
  text: string;
  thought?: boolean;
}

interface AdkAgentResponse {
  content?: {
    parts: ContentPart[];
  };
  output?: string;
  response?: string;
  role?: string;
  author?: string;
  usageMetadata?: unknown;
  actions?: unknown;
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    // Parse the request body
    const requestBody = await request.json();

    // Get the appropriate endpoints based on deployment type
    const sessionEndpoint = shouldUseAgentEngine()
      ? getAgentEngineQueryEndpoint()
      : `${endpointConfig.backendUrl}/run_sse`;
    const streamEndpoint = shouldUseAgentEngine()
      ? getAgentEngineStreamEndpoint()
      : `${endpointConfig.backendUrl}/run_sse`;

    // Log endpoint configuration in development
    if (process.env.NODE_ENV === "development") {
      console.log(`📡 Run SSE API - Session endpoint: ${sessionEndpoint}`);
      console.log(`📡 Run SSE API - Stream endpoint: ${streamEndpoint}`);
      console.log(`📡 Deployment type: ${endpointConfig.deploymentType}`);
    }

    // Handle Agent Engine vs regular backend deployment
    if (shouldUseAgentEngine()) {
      // Check if this is a session listing request
      if (requestBody.action === "list_sessions") {
        const userId = requestBody.userId;
        if (!userId) {
          return new Response(
            JSON.stringify({
              error: "User ID is required for listing sessions",
            }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }

        const listSessionsPayload = {
          class_method: "list_sessions",
          input: {
            user_id: userId,
          },
        };

        const authHeaders = await getAuthHeaders();
        const listResponse = await fetch(sessionEndpoint, {
          method: "POST",
          headers: {
            ...authHeaders,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(listSessionsPayload),
        });

        if (!listResponse.ok) {
          const errorText = await listResponse.text();
          console.error(
            `Agent Engine List Sessions Error: ${listResponse.status} ${listResponse.statusText}`,
            errorText
          );
          return new Response(
            JSON.stringify({ error: `Failed to list sessions: ${errorText}` }),
            {
              status: listResponse.status,
              headers: { "Content-Type": "application/json" },
            }
          );
        }

        const sessionData = await listResponse.json();
        return new Response(
          JSON.stringify(sessionData.output || { sessions: [] }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      // For Agent Engine, use the session-based API structure for messages
      const userId = requestBody.userId || `user-${Date.now()}`;
      const message = requestBody.query || requestBody.message || "";

      // Check if we already have a session ID from the request
      let sessionId = requestBody.sessionId;

      // If no session ID provided, create a new session
      if (!sessionId) {
        const createSessionPayload = {
          class_method: "create_session",
          input: {
            user_id: userId,
          },
        };

        const authHeaders = await getAuthHeaders();
        const createSessionResponse = await fetch(sessionEndpoint, {
          method: "POST",
          headers: {
            ...authHeaders,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(createSessionPayload),
        });

        if (!createSessionResponse.ok) {
          const errorText = await createSessionResponse.text();
          console.error(
            `Agent Engine Session Creation Error: ${createSessionResponse.status} ${createSessionResponse.statusText}`,
            errorText
          );
          return new Response(
            JSON.stringify({
              error: `Agent Engine Session Creation Error: ${errorText}`,
            }),
            {
              status: createSessionResponse.status,
              headers: { "Content-Type": "application/json" },
            }
          );
        }

        const sessionData = await createSessionResponse.json();
        sessionId = sessionData.output?.id;

        if (!sessionId) {
          console.error("No session ID returned from Agent Engine");
          return new Response(
            JSON.stringify({
              error: "Failed to create session: No session ID returned",
            }),
            {
              status: 500,
              headers: { "Content-Type": "application/json" },
            }
          );
        }
      }

      // Now stream the query to the session
      const streamQueryPayload = {
        class_method: "stream_query",
        input: {
          user_id: userId,
          session_id: sessionId,
          message: message,
        },
      };

      // Use the streaming endpoint (already defined above)
      const streamAuthHeaders = await getAuthHeaders();

      const streamResponse = await fetch(streamEndpoint, {
        method: "POST",
        headers: {
          ...streamAuthHeaders,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(streamQueryPayload),
      });

      if (!streamResponse.ok) {
        const errorText = await streamResponse.text();
        console.error(
          `Agent Engine Stream Error: ${streamResponse.status} ${streamResponse.statusText}`,
          errorText
        );
        return new Response(
          JSON.stringify({
            error: `Agent Engine Stream Error: ${errorText}`,
          }),
          {
            status: streamResponse.status,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      // Handle Agent Engine SSE response - forward the stream directly
      const stream = new ReadableStream({
        start(controller) {
          if (!streamResponse.body) {
            controller.close();
            return;
          }

          const reader = streamResponse.body.getReader();
          const decoder = new TextDecoder();

          async function pump() {
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });

                // Forward the SSE chunk as-is
                controller.enqueue(new TextEncoder().encode(chunk));
              }
            } catch (error) {
              console.error("Error reading Agent Engine stream:", error);
            } finally {
              controller.close();
            }
          }

          pump();
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    } else {
      // For regular backend deployment (local or Cloud Run)

      // Transform the request body to match ADK backend format
      const userId = requestBody.userId || `user-${Date.now()}`;
      const sessionId = requestBody.sessionId || `session-${Date.now()}`;
      const message = requestBody.query || requestBody.message || "";

      // First, create or ensure session exists
      const sessionEndpoint = `${endpointConfig.backendUrl}/apps/app/users/${userId}/sessions/${sessionId}`;

      try {
        const sessionAuthHeaders = await getAuthHeaders();
        const sessionResponse = await fetch(sessionEndpoint, {
          method: "POST",
          headers: {
            ...sessionAuthHeaders,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({}),
        });

        if (!sessionResponse.ok && sessionResponse.status !== 409) {
          console.error(
            "Session creation failed:",
            sessionResponse.status,
            await sessionResponse.text()
          );
        } else {
          console.log("Session created/verified successfully");
        }
      } catch (sessionError) {
        console.error("Session creation error:", sessionError);
      }

      // Prepare the ADK payload matching the expected format
      const adkPayload = {
        appName: "app",
        userId: userId,
        sessionId: sessionId,
        newMessage: {
          parts: [
            {
              text: message,
            },
          ],
          role: "user",
        },
        streaming: true,
      };

      const authHeaders = await getAuthHeaders();
      const response = await fetch(`${endpointConfig.backendUrl}/run_sse`, {
        method: "POST",
        headers: {
          ...authHeaders,
          "Content-Type": "application/json",
          // Forward any authentication headers if present
          ...(request.headers.get("authorization") && {
            authorization: request.headers.get("authorization")!,
          }),
        },
        body: JSON.stringify(adkPayload),
      });

      if (!response.ok) {
        return new Response(
          JSON.stringify({
            error: `Backend error: ${response.status} ${response.statusText}`,
          }),
          {
            status: response.status,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      // Create a new ReadableStream to proxy the SSE response
      const stream = new ReadableStream({
        start(controller) {
          const reader = response.body?.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          function pump(): Promise<void> {
            return reader!
              .read()
              .then(({ done, value }) => {
                if (done) {
                  controller.close();
                  return;
                }

                // Decode the chunk and add to buffer
                const chunk = decoder.decode(value, { stream: true });
                buffer += chunk;

                // Process complete SSE messages
                const lines = buffer.split("\n");
                buffer = lines.pop() || ""; // Keep incomplete line in buffer

                for (const line of lines) {
                  if (line.startsWith("data: ")) {
                    try {
                      const jsonData = line.substring(6); // Remove 'data: ' prefix
                      if (jsonData.trim()) {
                        const rawParsed = JSON.parse(jsonData) as
                          | AdkAgentResponse
                          | AdkAgentResponse[];

                        // Handle case where ADK agent returns an array with single response
                        const parsed: AdkAgentResponse =
                          Array.isArray(rawParsed) && rawParsed.length > 0
                            ? rawParsed[0]
                            : (rawParsed as AdkAgentResponse);

                        // Forward the complete parsed response to frontend
                        // This preserves all the metadata (author, actions, thoughts, etc.)
                        const sseData = {
                          content: parsed.content || {
                            parts: [
                              { text: parsed.output || parsed.response || "" },
                            ],
                          },
                          author: parsed.author,
                          actions: parsed.actions,
                          usageMetadata: parsed.usageMetadata,
                        };

                        const formattedChunk = `data: ${JSON.stringify(
                          sseData
                        )}\n\n`;
                        const encodedChunk = new TextEncoder().encode(
                          formattedChunk
                        );
                        controller.enqueue(encodedChunk);
                      }
                    } catch (error) {
                      console.error("Error parsing SSE data:", error);
                      // If parsing fails, forward the original line
                      const encodedChunk = new TextEncoder().encode(
                        line + "\n"
                      );
                      controller.enqueue(encodedChunk);
                    }
                  } else if (line.trim()) {
                    // Forward non-data lines (like comments or other SSE events)
                    const encodedChunk = new TextEncoder().encode(line + "\n");
                    controller.enqueue(encodedChunk);
                  }
                }

                // Continue reading
                return pump();
              })
              .catch((error) => {
                console.error("SSE stream error:", error);
                controller.error(error);
              });
          }

          return pump();
        },
      });

      // Return the streaming response with appropriate headers for SSE
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }
  } catch (error) {
    console.error("SSE endpoint error:", error);
    return new Response(
      JSON.stringify({
        error: "Failed to process SSE request",
        deploymentType: endpointConfig.deploymentType,
        environment: endpointConfig.environment,
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}

// Handle preflight requests for CORS
export async function OPTIONS(): Promise<Response> {
  return new Response(null, {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}
