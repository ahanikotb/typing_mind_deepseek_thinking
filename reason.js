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
      
        let buffer = '';
        let reasoningStarted = false;
        let reasoningEnded = false;
        let startThinkingTime = null;
        let citations = null;
        let responseFinished = false;
      
        const stream = new ReadableStream({
          async start(controller) {
            const textEncoder = new TextEncoder();
      
            try {
              while (true) {
                const { done, value } = await reader.read();
                
                if (done && !responseFinished) {
                  responseFinished = true;
                  // Only add citations if we have them
                  if (citations && citations.length > 0) {
                    // Add a separator before citations
                    const citationsChunk = {
                      choices: [{
                        delta: {
                          content: '\n\n---\n\nSources:\n' + citations.map(
                            (citation, i) => `[${i + 1}]> ${citation}`
                          ).join('\n')
                        }
                      }]
                    };
                    controller.enqueue(
                      textEncoder.encode(`data: ${JSON.stringify(citationsChunk)}\n\n`)
                    );
                  }
                  break;
                }
      
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
      
                for (const line of lines) {
                  if (line.startsWith('data: ')) {
                    if (line.includes('[DONE]')) {
                      controller.enqueue(textEncoder.encode(`${line}\n`));
                      continue;
                    }
      
                    try {
                      const data = JSON.parse(line.slice(6));
      
                      // Store citations if we find them
                      if (data.citations && !citations) {
                        citations = data.citations;
                      }
      
                      if (data?.choices?.[0]?.delta) {
                        const delta = data.choices[0].delta;
      
                        if (delta.reasoning && !delta.content) {
                          if (!reasoningStarted) {
                            startThinkingTime = performance.now();
                            const thinkingHeader = {
                              choices: [{
                                delta: { content: '💭 Thinking...\n\n> ' }
                              }]
                            };
                            controller.enqueue(
                              textEncoder.encode(`data: ${JSON.stringify(thinkingHeader)}\n\n`)
                            );
                            reasoningStarted = true;
                          }
      
                          const content = delta.reasoning.replace(/\n/g, '\n> ');
                          const modifiedData = {
                            choices: [{
                              delta: { content }
                            }]
                          };
                          controller.enqueue(
                            textEncoder.encode(`data: ${JSON.stringify(modifiedData)}\n\n`)
                          );
                        } else if (delta.content !== undefined && reasoningStarted && !reasoningEnded) {
                          reasoningEnded = true;
      
                          const thinkingDuration = Math.round(
                            (performance.now() - startThinkingTime) / 1000
                          );
      
                          const separatorData = {
                            choices: [{
                              delta: {
                                content: `\n\n💡 Thought for ${thinkingDuration} seconds\n\n---\n\n`
                              }
                            }]
                          };
                          controller.enqueue(
                            textEncoder.encode(`data: ${JSON.stringify(separatorData)}\n\n`)
                          );
      
                          controller.enqueue(textEncoder.encode(`${line}\n`));
                        } else {
                          controller.enqueue(textEncoder.encode(`${line}\n`));
                        }
                      } else {
                        controller.enqueue(textEncoder.encode(`${line}\n`));
                      }
                    } catch (parseError) {
                      console.error('Error parsing streaming data:', parseError);
                      controller.enqueue(textEncoder.encode(`${line}\n`));
                    }
                  } else {
                    controller.enqueue(textEncoder.encode(`${line}\n`));
                  }
                }
              }
      
              controller.close();
            } catch (error) {
              console.error('Streaming error:', error);
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
            .map((citation, i) => `[${i + 1}]> ${citation}`)
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
  
