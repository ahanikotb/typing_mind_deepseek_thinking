(function() {
    /**
     * ------------------------------------------------------
     * 1. Preserve the original fetch for fallback behavior.
     * ------------------------------------------------------
     */
    const originalFetch = window.fetch;
  
    /**
     * ------------------------------------------------------
     * 2. Deepseek API endpoint to intercept.
     * ------------------------------------------------------
     */
    const DEEPSEEK_API_URL = 'openrouter.ai/api/v1/chat/completions';
  
    /**
     * ------------------------------------------------------
     * Helper Function: Check if a given URL is the Deepseek endpoint.
     * @param {string} url - The request URL (args[0] from fetch).
     * @returns {boolean} - True if the URL includes the Deepseek API endpoint.
     * ------------------------------------------------------
     */
    function isDeepseekURL(url) {
      return url && url.includes(DEEPSEEK_API_URL);
    }
  
    /**
     * ------------------------------------------------------
     * Helper Function: Check if the request body references a Deepseek model.
     * @param {Object} body - Parsed JSON request body.
     * @returns {boolean} - True if the model field includes 'deepseek'.
     * ------------------------------------------------------
     */
    function isDeepseekModel(body) {
      return !!body.model &&( body.model.includes('deepseek') || body.model.includes('reasoning')); ;
    }
  
    /**
     * ------------------------------------------------------
     * Helper Function: Check if the request is a title generation request.
     * @param {Object} body - Parsed JSON request body.
     * @returns {boolean} - True if the last message prompts for a short/relevant title.
     * ------------------------------------------------------
     */
    function isTitleRequest(body) {
      if (!body.messages || body.messages.length === 0) return false;
      const lastMessage = body.messages[body.messages.length - 1];
      return (
        !!lastMessage.content &&
        lastMessage.content.startsWith('What would be a short and relevant title for this chat?')
      );
    }
  
    /**
     * ------------------------------------------------------
     * Function: Process a streaming text/event-stream response from Deepseek,
     *   intercepting "reasoning_content" and measuring how long
     *   the "thinking" phase lasted.
     * @param {Response} response - The original response from fetch.
     * @returns {Promise<Response>}
     * ------------------------------------------------------
     */
    async function processStreamingResponse(response) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const textEncoder = new TextEncoder();
        let buffer = '';
        let reasoningStarted = false;
        let reasoningEnded = false;
        let startThinkingTime = null;
        let citations = null;
      
        const stream = new ReadableStream({
          async start(controller) {
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
      
                // Decode incoming bytes and split into lines
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                // Keep the last (possibly incomplete) line in the buffer
                buffer = lines.pop() || '';
      
                for (const line of lines) {
                  // Process only lines that start with "data: "
                  if (line.startsWith('data: ')) {
                    // If the line indicates the end of the stream...
                    if (line.includes('[DONE]')) {
                      // If we have citations waiting to be sent, send them first
                      if (citations) {
                        const citationsText = citations
                          .map((citation, i) => `[${i + 1}] > ${citation}`)
                          .join("\n");
                        const citationsMessage = `data: ${JSON.stringify({
                          citations: citationsText
                        })}\n\n`;
                        controller.enqueue(textEncoder.encode(citationsMessage));
                        // Clear citations so we don't send them twice
                        citations = null;
                      }
                      // Then enqueue the [DONE] message and continue
                      controller.enqueue(textEncoder.encode(`${line}\n`));
                      continue;
                    }
      
                    try {
                      // Parse the JSON from the SSE line
                      const data = JSON.parse(line.slice(6));
      
                      // Capture citations if they appear in any chunk (first occurrence)
                      if (data.citations && !citations) {
                        citations = data.citations;
                      }
      
                      // Process chunks that include a "delta" payload
                      if (data?.choices?.[0]?.delta) {
                        const delta = data.choices[0].delta;
      
                        // If it's reasoning content (with no normal content yet)
                        if (delta.reasoning && delta.content === null) {
                          if (!reasoningStarted) {
                            startThinkingTime = performance.now();
                            // Send a "thinking" header message once
                            const thinkingHeader = {
                              ...data,
                              choices: [{
                                ...data.choices[0],
                                delta: { content: '💭 Thinking...\n\n> ' }
                              }]
                            };
                            controller.enqueue(
                              textEncoder.encode(`data: ${JSON.stringify(thinkingHeader)}\n\n`)
                            );
                            reasoningStarted = true;
                          }
      
                          // Prefix every line of the reasoning text with "> "
                          const content = delta.reasoning.replace(/\n/g, '\n> ');
                          const modifiedData = {
                            ...data,
                            choices: [{
                              ...data.choices[0],
                              delta: { content }
                            }]
                          };
                          controller.enqueue(
                            textEncoder.encode(`data: ${JSON.stringify(modifiedData)}\n\n`)
                          );
                        }
                        // When normal content arrives after reasoning has started
                        else if (delta.content !== null && reasoningStarted && !reasoningEnded) {
                          reasoningEnded = true;
                          // Calculate how long the "thinking" lasted
                          const thinkingDuration = Math.round(
                            (performance.now() - startThinkingTime) / 1000
                          );
                          const separatorData = {
                            ...data,
                            choices: [{
                              ...data.choices[0],
                              delta: {
                                content: `\n\n💡 Thought for ${thinkingDuration} seconds\n\n---\n\n`
                              }
                            }]
                          };
                          controller.enqueue(
                            textEncoder.encode(`data: ${JSON.stringify(separatorData)}\n\n`)
                          );
                          // Then send along the current content line as-is
                          controller.enqueue(textEncoder.encode(`${line}\n`));
                        } else {
                          // For any other delta, just forward the line unchanged
                          controller.enqueue(textEncoder.encode(`${line}\n`));
                        }
                      } else {
                        // If no delta is present, just pass the line along
                        controller.enqueue(textEncoder.encode(`${line}\n`));
                      }
                    } catch (parseError) {
                      console.error('Error parsing streaming data:', parseError);
                      controller.enqueue(textEncoder.encode(`${line}\n`));
                    }
                  } else {
                    // For lines not starting with "data: ", pass them unchanged
                    controller.enqueue(textEncoder.encode(`${line}\n`));
                  }
                }
              }
      
              // In case the stream ended without a [DONE] event, send citations now.
              if (citations) {
                const citationsText = citations
                  .map((citation, i) => `[${i + 1}] > ${citation}`)
                  .join("\n");
                const citationsMessage = `data: ${JSON.stringify({ citations: citationsText })}\n\n`;
                controller.enqueue(textEncoder.encode(citationsMessage));
              }
      
              controller.close();
            } catch (error) {
              controller.error(error);
            }
          }
        });
      
        return new Response(stream, {
          headers: response.headers,
          status: response.status,
          statusText: response.statusText
        });
      }
      
    /**
     * ------------------------------------------------------
     * Function: Process a non-streaming JSON response from Deepseek.
     * If we see 'reasoning_content' in the JSON body, prefix each line
     * with '>' and insert a separator (---) before the original content.
     * @param {Response} response - The original fetch response.
     * @returns {Promise<Response>}
     * ------------------------------------------------------
     */
    async function processNonStreamingResponse(response) {
      try {
        // Clone the response so we can parse it independently
        const cloned = response.clone();
        const data = await cloned.json();
  
        // Look for reasoning_content in the first choice
        if (data?.choices?.[0]?.message?.reasoning) {
          const message = data.choices[0].message;
          const quotedReasoning = message.reasoning
            .split('\n')
            .map(line => (line.trim() ? `> ${line}` : '>'))
            .join('\n');
  
        if (data?.citations){
            console.log(data.citations)
        // Insert reasoning before the main content and then add the citations
        message.content = `${quotedReasoning}\n\n---\n\n${message.content}\n\n---\n\n${data.citations
            .map((citation, i) => `[${i + 1}] > ${citation}`)
            .join("\n")}`;
        }else{
              // Insert reasoning before the main content
          message.content = `${quotedReasoning}\n\n---\n\n---\n\n${message.content}`;
        }
        
  
          // Return a new Response with the updated JSON
          return new Response(JSON.stringify(data), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
          });
        }
      } catch (error) {
        console.error('Error in Deepseek reasoning extension (non-streaming):', error);
      }
  
      // If no modifications are needed, return the original response
      return response;
    }
  
    /**
     * ------------------------------------------------------
     * Main override: window.fetch
     * Intercepts calls to the Deepseek endpoint and modifies
     * reasoning content in streaming/non-streaming responses.
     * ------------------------------------------------------
     */
    window.fetch = async function(...args) {
      try {
        const [url, options] = args;
        const requestBody = options?.body;
  
        // 1. If not a Deepseek URL, fall back to the original fetch
        if (!isDeepseekURL(url)) {
          return originalFetch.apply(this, args);
        }
  
        // 2. If no request body, we can't parse or modify
        if (!requestBody) {
          return originalFetch.apply(this, args);
        }
  
        // 3. Attempt to parse the request body to identify the model
        let parsedBody;
        try {
          parsedBody = JSON.parse(requestBody);
        } catch {
          // If parse fails, just continue with the original fetch
          return originalFetch.apply(this, args);
        }
  
        // 4. If it's not a Deepseek model or it's a title request, do nothing special
        if (!isDeepseekModel(parsedBody) || isTitleRequest(parsedBody)) {
          return originalFetch.apply(this, args);
        }
  
        // 5. Make the actual fetch call to get the response
        const response = await originalFetch.apply(this, args);
  
        // 6. Check the content-type for streaming
        if (response.headers.get('content-type')?.includes('text/event-stream')) {
          // Use our special streaming handler
          return processStreamingResponse(response);
        }
  
        // 7. Otherwise, handle it as a normal JSON response
        return processNonStreamingResponse(response);
      } catch (error) {
        console.error('Error in fetch interceptor:', error);
        // If there's an error, fallback to the original fetch
        return originalFetch.apply(this, args);
      }
    };
  
    console.log('Deepseek reasoning extension loaded (with timing & updated emojis)!');
  })();
  
