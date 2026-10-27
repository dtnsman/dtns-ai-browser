try { window.__dtnsContentScriptVersion = '2.0.1-click-fix'; } catch (e) { /* ignore */ }
// content-script.js - 内容脚本
// 处理来自background的命令

// 选区状态
let isSelecting = false;
let startPoint = { x: 0, y: 0 };
let endPoint = { x: 0, y: 0 };
let selectionOverlay = null;
let selectionRect = null;

// API 配置
const OCR_URL = "http://ocr.html.dtns.top/api/ocr";
const SMART_REPLY_URL = "http://ibbot.devibbot.html.dtns.top/rtagent/ibbot_agent/smart_reply";//"http://192.168.1.15:33233/rtagent/ibbot_agent/smart_reply";
const SECRET_KEY = "HWbVFs1cZ9X9KayMUq3J";
const USER_ID = "user_9CcLMDTUBgwFZM9V";

// ============ 命令处理 ============
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('[Content] 收到消息:', request.action);

  // 添加 ping 响应（用于检测 content script 是否存活）
  if (request.action === 'ping') {
    sendResponse({ success: true, status: 'alive' });
    return true;
  }
  
  const handlers = {
    // 机灵回复
    smart_reply: async () => {
      const { text, context } = request;
      const result = await callSmartReply(text, context);
      sendResponse(result);
    },
    
    // 获取页面信息
    get_page_info: async () => {
      sendResponse({
        url: window.location.href,
        title: document.title,
        readyState: document.readyState
      });
    },
    
    // 执行JavaScript
    evaluate: async () => {
      try {
        const result = eval(request.script);
        sendResponse({ result: typeof result === 'object' ? JSON.stringify(result) : String(result) });
      } catch (error) {
        sendResponse({ error: error.message });
      }
    },
    
    // 查询DOM
    query_dom: async () => {
      const { selector, all } = request;
      try {
        if (all) {
          const elements = document.querySelectorAll(selector);
          const results = Array.from(elements).map(el => ({
            tag: el.tagName,
            text: el.textContent?.substring(0, 200),
            html: el.outerHTML?.substring(0, 500)
          }));
          sendResponse({ results });
        } else {
          const el = document.querySelector(selector);
          if (el) {
            sendResponse({
              exists: true,
              tag: el.tagName,
              text: el.textContent?.substring(0, 200),
              html: el.outerHTML?.substring(0, 500)
            });
          } else {
            sendResponse({ exists: false });
          }
        }
      } catch (error) {
        sendResponse({ error: error.message });
      }
    },

    // 获取视口信息
    get_viewport_info: async () => {
      sendResponse(getViewportInfo());
    },

    // 获取元素文档位置
    get_element_position: async () => {
      const { selector } = request;
      try {
        const element = document.querySelector(selector);
        if (!element) {
          sendResponse({ error: `Element not found: ${selector}` });
          return;
        }
        const position = getElementDocumentPosition(element);
        sendResponse({ success: true, position: position, selector: selector });
      } catch (error) {
        sendResponse({ error: error.message });
      }
    },
    
    // 点击元素
    click_element: async () => {
      const { selector } = request;
      try {
        const el = document.querySelector(selector);
        if (el) {
          el.click();
          sendResponse({ success: true });
        } else {
          sendResponse({ error: `Element not found: ${selector}` });
        }
      } catch (error) {
        sendResponse({ error: error.message });
      }
    },

    // 修复：点击指定坐标
    // 在 handlers 对象中替换原有的 click_at_coordinates
    click_at_coordinates: async () => {
      const { x, y, double, button, usePageCoordinates = false } = request;
      
      try {
        // 获取视口信息
        const viewport = getViewportInfo();
        
        // 计算实际点击坐标
        let clientX, clientY;
        
        if (usePageCoordinates) {
          // 如果传入的是页面绝对坐标，转换为视口坐标
          clientX = x - viewport.scrollX;
          clientY = y - viewport.scrollY;
        } else {
          // 传入的是视口坐标，直接使用
          clientX = x;
          clientY = y;
        }
        
        // 考虑缩放
        if (viewport.visualViewport && viewport.visualViewport.scale !== 1) {
          clientX = clientX * viewport.visualViewport.scale;
          clientY = clientY * viewport.visualViewport.scale;
        }
        
        // 确保坐标在视口范围内
        clientX = Math.max(0, Math.min(clientX, viewport.clientWidth));
        clientY = Math.max(0, Math.min(clientY, viewport.clientHeight));
        
        // 获取目标元素
        const element = document.elementFromPoint(clientX, clientY);
        
        if (!element) {
          sendResponse({ 
            error: `No element found at viewport coordinates (${clientX}, ${clientY})`,
            viewport: viewport,
            requested: { x, y, usePageCoordinates }
          });
          return;
        }
        
        // 获取元素的文档位置
        const elementPos = getElementDocumentPosition(element);
        
        // 创建鼠标事件配置
        const eventConfig = {
          view: window,
          bubbles: true,
          cancelable: true,
          clientX: clientX,
          clientY: clientY,
          button: button === 'right' ? 2 : (button === 'middle' ? 1 : 0),
          buttons: button === 'right' ? 2 : (button === 'middle' ? 4 : 1)
        };
        
        // 触发鼠标事件序列。
        // 注意：以前这里既 dispatch 了合成 click，又调用 element.click()，
        // 导致一次 /api/click/at 触发两次 click（重复提交、开关被切两次）。
        // 现在只派发 mousedown/mouseup，click 统一交给原生 click()——它既触发
        // 监听器，也执行 <a> 跳转等默认动作。
        const down = new MouseEvent('mousedown', eventConfig);
        const up = new MouseEvent('mouseup', eventConfig);

        if (double) {
          element.dispatchEvent(down);
          element.dispatchEvent(up);
          element.click();
          element.click();
          element.dispatchEvent(new MouseEvent('dblclick', eventConfig));
        } else if (button === 'right' || button === 'middle') {
          element.dispatchEvent(down);
          element.dispatchEvent(up);
          if (button === 'right') {
            element.dispatchEvent(new MouseEvent('contextmenu', eventConfig));
          }
        } else {
          element.dispatchEvent(down);
          element.dispatchEvent(up);
          element.click();
        }

        // 聚焦元素
        if (element.focus && button !== 'right') {
          element.focus();
        }
        // 获取元素信息
        const rect = element.getBoundingClientRect();
        
        sendResponse({
          success: true,
          element: {
            tag: element.tagName,
            id: element.id || null,
            className: element.className || null,
            text: element.textContent?.substring(0, 100) || null,
            href: element.href || null
          },
          viewportCoordinates: { x: clientX, y: clientY },
          pageCoordinates: { x: clientX + viewport.scrollX, y: clientY + viewport.scrollY },
          elementPosition: elementPos,
          double: double || false,
          button: button || 'left'
        });
        
      } catch (error) {
        sendResponse({ error: error.message });
      }
    },

    // 修复：鼠标移动到指定坐标
    mouse_move_to: async () => {
      const { x, y, usePageCoordinates = false } = request;
      
      try {
        const viewport = getViewportInfo();
        
        // 计算实际移动坐标
        let clientX, clientY;
        
        if (usePageCoordinates) {
          clientX = x - viewport.scrollX;
          clientY = y - viewport.scrollY;
        } else {
          clientX = x;
          clientY = y;
        }
        
        // 考虑缩放
        if (viewport.visualViewport && viewport.visualViewport.scale !== 1) {
          clientX = clientX * viewport.visualViewport.scale;
          clientY = clientY * viewport.visualViewport.scale;
        }
        
        // 确保坐标在视口范围内
        clientX = Math.max(0, Math.min(clientX, viewport.clientWidth));
        clientY = Math.max(0, Math.min(clientY, viewport.clientHeight));
        
        // 获取目标元素
        const element = document.elementFromPoint(clientX, clientY);
        
        if (!element) {
          sendResponse({ 
            error: `No element found at coordinates (${clientX}, ${clientY})`,
            viewport: viewport
          });
          return;
        }
        
        // 创建鼠标移动事件
        const mouseMoveEvent = new MouseEvent('mousemove', {
          view: window,
          bubbles: true,
          cancelable: true,
          clientX: clientX,
          clientY: clientY
        });
        
        // 触发 mouseover 和 mousemove 事件
        element.dispatchEvent(mouseMoveEvent);
        
        const mouseOverEvent = new MouseEvent('mouseover', {
          view: window,
          bubbles: true,
          cancelable: true,
          clientX: clientX,
          clientY: clientY
        });
        element.dispatchEvent(mouseOverEvent);
        
        // 可选：添加高亮效果
        const originalOutline = element.style.outline;
        element.style.outline = '2px solid #60a5fa';
        setTimeout(() => {
          element.style.outline = originalOutline;
        }, 200);
        
        sendResponse({
          success: true,
          element: {
            tag: element.tagName,
            id: element.id || null,
            className: element.className || null,
            text: element.textContent?.substring(0, 100) || null
          },
          viewportCoordinates: { x: clientX, y: clientY },
          pageCoordinates: { x: clientX + viewport.scrollX, y: clientY + viewport.scrollY }
        });
        
      } catch (error) {
        sendResponse({ error: error.message });
      }
    },

    // 修复：右键点击
    right_click_at: async () => {
      const { x, y, usePageCoordinates = false } = request;
      
      try {
        const viewport = getViewportInfo();
        
        let clientX, clientY;
        
        if (usePageCoordinates) {
          clientX = x - viewport.scrollX;
          clientY = y - viewport.scrollY;
        } else {
          clientX = x;
          clientY = y;
        }
        
        if (viewport.visualViewport && viewport.visualViewport.scale !== 1) {
          clientX = clientX * viewport.visualViewport.scale;
          clientY = clientY * viewport.visualViewport.scale;
        }
        
        clientX = Math.max(0, Math.min(clientX, viewport.clientWidth));
        clientY = Math.max(0, Math.min(clientY, viewport.clientHeight));
        
        const element = document.elementFromPoint(clientX, clientY);
        
        if (!element) {
          sendResponse({ error: `No element found at coordinates (${clientX}, ${clientY})` });
          return;
        }
        
        // 创建右键点击事件
        const eventConfig = {
          view: window,
          bubbles: true,
          cancelable: true,
          clientX: clientX,
          clientY: clientY,
          button: 2,
          buttons: 2
        };
        
        const events = [
          new MouseEvent('mousedown', eventConfig),
          new MouseEvent('mouseup', eventConfig),
          new MouseEvent('click', eventConfig),
          new MouseEvent('contextmenu', eventConfig)
        ];
        
        for (const event of events) {
          element.dispatchEvent(event);
        }
        
        sendResponse({
          success: true,
          element: {
            tag: element.tagName,
            id: element.id || null,
            className: element.className || null
          },
          viewportCoordinates: { x: clientX, y: clientY },
          pageCoordinates: { x: clientX + viewport.scrollX, y: clientY + viewport.scrollY }
        });
        
      } catch (error) {
        sendResponse({ error: error.message });
      }
    },

    // 修复：双击
    double_click_at: async () => {
      const { x, y, usePageCoordinates = false } = request;
      
      try {
        const viewport = getViewportInfo();
        
        let clientX, clientY;
        
        if (usePageCoordinates) {
          clientX = x - viewport.scrollX;
          clientY = y - viewport.scrollY;
        } else {
          clientX = x;
          clientY = y;
        }
        
        if (viewport.visualViewport && viewport.visualViewport.scale !== 1) {
          clientX = clientX * viewport.visualViewport.scale;
          clientY = clientY * viewport.visualViewport.scale;
        }
        
        clientX = Math.max(0, Math.min(clientX, viewport.clientWidth));
        clientY = Math.max(0, Math.min(clientY, viewport.clientHeight));
        
        const element = document.elementFromPoint(clientX, clientY);
        
        if (!element) {
          sendResponse({ error: `No element found at coordinates (${clientX}, ${clientY})` });
          return;
        }
        
        const eventConfig = {
          view: window,
          bubbles: true,
          cancelable: true,
          clientX: clientX,
          clientY: clientY,
          button: 0,
          buttons: 1,
          detail: 2
        };
        
        // 触发双击事件序列
        const events = [
          new MouseEvent('mousedown', eventConfig),
          new MouseEvent('mouseup', eventConfig),
          new MouseEvent('click', eventConfig),
          new MouseEvent('mousedown', eventConfig),
          new MouseEvent('mouseup', eventConfig),
          new MouseEvent('click', eventConfig),
          new MouseEvent('dblclick', eventConfig)
        ];
        
        for (const event of events) {
          element.dispatchEvent(event);
        }
        
        // 同时调用原生 click 方法
        element.click();
        
        sendResponse({
          success: true,
          element: {
            tag: element.tagName,
            id: element.id || null,
            className: element.className || null
          },
          viewportCoordinates: { x: clientX, y: clientY },
          pageCoordinates: { x: clientX + viewport.scrollX, y: clientY + viewport.scrollY }
        });
        
      } catch (error) {
        sendResponse({ error: error.message });
      }
    },
    
    // 输入文本
    type_text: async () => {
      const { selector, text } = request;
      try {
        const el = document.querySelector(selector);
        if (el) {
          if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
            el.value = text;
            el.dispatchEvent(new Event('input', { bubbles: true }));
          } else {
            el.textContent = text;
          }
          sendResponse({ success: true });
        } else {
          sendResponse({ error: `Element not found: ${selector}` });
        }
      } catch (error) {
        sendResponse({ error: error.message });
      }
    },
    
    // 导航
    navigate: async () => {
      const { url } = request;
      window.location.href = url;
      sendResponse({ success: true, url });
    },
    
    // 刷新
    refresh: async () => {
      window.location.reload();
      sendResponse({ success: true });
    },
    
    // 滚动
    scroll: async () => {
      const { x, y } = request;
      window.scrollTo(x, y);
      sendResponse({ success: true });
    },
    
    // 获取选中的文本
    get_selected_text: async () => {
      const selectedText = window.getSelection().toString();
      sendResponse(selectedText);
    },

    // 截图功能 - 替换原有的简单实现
    // 修改 handlers 中的 screenshot 函数
    screenshot: async () => {
    try {
        const result = await captureVisibleTab();
        if (result && result.imageData) {
        sendResponse({ 
            success: true, 
            image: result.imageData,
            format: 'base64',
            mimeType: 'image/png'
        });
        } else {
        sendResponse({ 
            success: false, 
            error: 'Failed to capture screenshot',
            note: 'Please ensure the page is visible and not a chrome:// page'
        });
        }
    } catch (error) {
        sendResponse({ 
        success: false, 
        error: error.message,
        note: 'Screenshot failed, try clicking on the page first to activate the tab'
        });
    }
    },
    
    // 启动选区模式
    startSmartSelect: () => {
      if (selectionOverlay) removeOverlay();
      createOverlay();
      sendResponse({ status: "started" });
    },

    // 在 chrome.runtime.onMessage 的 handlers 对象中添加以下处理函数：

    // 获取整个页面元素信息（完整DOM树）
    get_page_elements: async () => {
    try {
        const elements = extractPageElements(document.body);
        sendResponse({ 
        success: true, 
        elements: elements,
        totalCount: countElements(elements)
        });
    } catch (error) {
        sendResponse({ error: error.message });
    }
    },

    // 获取精简的页面元素信息
    get_page_elements_simple: async () => {
    try {
        const elements = extractPageElementsSimple(document.body);
        sendResponse({ 
        success: true, 
        elements: elements,
        totalCount: elements.length
        });
    } catch (error) {
        sendResponse({ error: error.message });
    }
    },

    // 获取页面所有链接
    get_page_links: async () => {
    try {
        const links = Array.from(document.querySelectorAll('a')).map(a => ({
        href: a.href,
        text: a.textContent?.trim() || '',
        title: a.title || '',
        target: a.target || '',
        rel: a.rel || '',
        visible: isElementVisible(a)
        }));
        sendResponse({ success: true, links: links, total: links.length });
    } catch (error) {
        sendResponse({ error: error.message });
    }
    },

    // 获取页面所有图片
    get_page_images: async () => {
    try {
        const images = Array.from(document.querySelectorAll('img')).map(img => ({
        src: img.src,
        alt: img.alt || '',
        title: img.title || '',
        width: img.width,
        height: img.height,
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        visible: isElementVisible(img)
        }));
        sendResponse({ success: true, images: images, total: images.length });
    } catch (error) {
        sendResponse({ error: error.message });
    }
    },

    // 获取页面所有表单
    get_page_forms: async () => {
    try {
        const forms = Array.from(document.querySelectorAll('form')).map(form => ({
        id: form.id,
        name: form.name,
        action: form.action,
        method: form.method,
        enctype: form.enctype,
        fields: Array.from(form.elements).map(el => ({
            type: el.type,
            name: el.name,
            id: el.id,
            value: el.value,
            placeholder: el.placeholder,
            required: el.required,
            disabled: el.disabled
        }))
        }));
        sendResponse({ success: true, forms: forms, total: forms.length });
    } catch (error) {
        sendResponse({ error: error.message });
    }
    },

    // 获取页面所有输入框
    get_page_inputs: async () => {
    try {
        const inputs = Array.from(document.querySelectorAll('input, textarea, select')).map(input => ({
        type: input.type || input.tagName,
        name: input.name,
        id: input.id,
        value: input.value,
        placeholder: input.placeholder,
        required: input.required,
        disabled: input.disabled,
        readonly: input.readOnly,
        visible: isElementVisible(input)
        }));
        sendResponse({ success: true, inputs: inputs, total: inputs.length });
    } catch (error) {
        sendResponse({ error: error.message });
    }
    },

    // 获取页面所有按钮
    get_page_buttons: async () => {
    try {
        const buttons = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"], input[type="reset"]')).map(btn => ({
        type: btn.type || 'button',
        text: btn.textContent?.trim() || btn.value || '',
        name: btn.name,
        id: btn.id,
        disabled: btn.disabled,
        visible: isElementVisible(btn)
        }));
        sendResponse({ success: true, buttons: buttons, total: buttons.length });
    } catch (error) {
        sendResponse({ error: error.message });
    }
    },

    // 获取指定选择器的元素信息
    get_element_info: async () => {
    const { selector } = request;
    try {
        const el = document.querySelector(selector);
        if (!el) {
        sendResponse({ exists: false, message: `Element not found: ${selector}` });
        return;
        }
        
        const rect = el.getBoundingClientRect();
        const computedStyle = window.getComputedStyle(el);
        
        sendResponse({
        exists: true,
        tag: el.tagName,
        id: el.id,
        className: el.className,
        text: el.textContent?.substring(0, 500),
        innerHTML: el.innerHTML?.substring(0, 1000),
        outerHTML: el.outerHTML?.substring(0, 1000),
        attributes: getElementAttributes(el),
        position: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            top: rect.top,
            bottom: rect.bottom,
            left: rect.left,
            right: rect.right
        },
        style: {
            color: computedStyle.color,
            backgroundColor: computedStyle.backgroundColor,
            fontSize: computedStyle.fontSize,
            display: computedStyle.display,
            visibility: computedStyle.visibility,
            opacity: computedStyle.opacity,
            zIndex: computedStyle.zIndex
        },
        visible: isElementVisible(el),
        enabled: !el.disabled,
        value: el.value,
        href: el.href,
        src: el.src
        });
    } catch (error) {
        sendResponse({ error: error.message });
    }
    },

    // 在 chrome.runtime.onMessage 的 handlers 对象中添加以下处理函数：

    // 获取页面可见文本内容（带位置信息 + 汇总文本）
    get_visible_text: async () => {
    const { includePosition = true, mergeText = true } = request;
    try {
        // 获取所有可见文本块
        const textBlocks = extractVisibleTextBlocks();
        
        // 合并所有文本
        let mergedText = '';
        if (mergeText) {
        mergedText = textBlocks.map(block => block.text).join('\n');
        }
        
        const result = {
        success: true,
        totalBlocks: textBlocks.length,
        totalLength: mergedText.length,
        url: window.location.href,
        title: document.title
        };
        
        if (includePosition) {
        result.blocks = textBlocks;
        }
        
        if (mergeText) {
        result.mergedText = mergedText;
        }
        
        sendResponse(result);
    } catch (error) {
        sendResponse({ error: error.message });
    }
    },

    // 获取页面可见文本块（带位置信息）
    get_visible_text_blocks: async () => {
    try {
        const blocks = extractVisibleTextBlocks();
        sendResponse({ 
        success: true, 
        blocks: blocks,
        total: blocks.length,
        url: window.location.href,
        title: document.title
        });
    } catch (error) {
        sendResponse({ error: error.message });
    }
    },

    // 获取页面可见文本（合并）
    get_visible_text_merged: async () => {
    const { separator = '\n' } = request;
    try {
        const textBlocks = extractVisibleTextBlocks();
        const mergedText = textBlocks.map(block => block.text).join(separator);
        sendResponse({ 
        success: true, 
        text: mergedText,
        length: mergedText.length,
        blockCount: textBlocks.length,
        url: window.location.href,
        title: document.title
        });
    } catch (error) {
        sendResponse({ error: error.message });
    }
    },


    // 在 chrome.runtime.onMessage 的 handlers 中添加/完善

    // 复制到剪贴板（增强版）
    copy_to_clipboard: async () => {
      const { text, html } = request;
      
      if (!text && !html) {
        sendResponse({ error: 'text or html content is required' });
        return;
      }
      
      try {
        // 使用现代 Clipboard API
        if (navigator.clipboard && navigator.clipboard.write) {
          const clipboardItems = [];
          
          // 添加纯文本
          if (text) {
            clipboardItems.push(
              new ClipboardItem({
                'text/plain': new Blob([text], { type: 'text/plain' })
              })
            );
          }
          
          // 添加 HTML 格式（如果提供）
          if (html) {
            clipboardItems.push(
              new ClipboardItem({
                'text/html': new Blob([html], { type: 'text/html' })
              })
            );
          }
          
          await navigator.clipboard.write(clipboardItems);
        } 
        // 降级方案：使用 execCommand
        else if (text) {
          const textarea = document.createElement('textarea');
          textarea.value = text;
          textarea.style.position = 'fixed';
          textarea.style.opacity = '0';
          document.body.appendChild(textarea);
          textarea.select();
          document.execCommand('copy');
          document.body.removeChild(textarea);
        }
        
        sendResponse({ 
          success: true, 
          message: 'Content copied to clipboard',
          type: html ? 'html' : 'text',
          length: (text || html).length
        });
        
      } catch (error) {
        console.error('Copy failed:', error);
        sendResponse({ error: error.message });
      }
    },

    // 读取剪贴板（增强版）
    read_clipboard: async () => {
      try {
        let text = '';
        let html = '';
        
        // 使用现代 Clipboard API
        if (navigator.clipboard && navigator.clipboard.read) {
          try {
            const clipboardItems = await navigator.clipboard.read();
            
            for (const item of clipboardItems) {
              // 读取纯文本
              if (item.types.includes('text/plain')) {
                const blob = await item.getType('text/plain');
                text = await blob.text();
              }
              // 读取 HTML
              if (item.types.includes('text/html')) {
                const blob = await item.getType('text/html');
                html = await blob.text();
              }
            }
          } catch (permError) {
            // 权限错误，尝试降级方案
            console.warn('Clipboard read permission denied, using fallback');
            const textarea = document.createElement('textarea');
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.focus();
            document.execCommand('paste');
            text = textarea.value;
            document.body.removeChild(textarea);
          }
        } 
        // 降级方案：使用 execCommand
        else {
          const textarea = document.createElement('textarea');
          textarea.style.position = 'fixed';
          textarea.style.opacity = '0';
          document.body.appendChild(textarea);
          textarea.focus();
          document.execCommand('paste');
          text = textarea.value;
          document.body.removeChild(textarea);
        }
        
        sendResponse({ 
          success: true, 
          text: text,
          html: html || null,
          length: text.length,
          hasHtml: !!html
        });
        
      } catch (error) {
        console.error('Read clipboard failed:', error);
        sendResponse({ error: error.message });
      }
    },

    // 追加内容到剪贴板
    append_to_clipboard: async () => {
      const { text, separator = '\n' } = request;
      
      if (!text) {
        sendResponse({ error: 'text is required' });
        return;
      }
      
      try {
        // 先读取现有内容
        let existingText = '';
        
        if (navigator.clipboard && navigator.clipboard.read) {
          try {
            const clipboardItems = await navigator.clipboard.read();
            for (const item of clipboardItems) {
              if (item.types.includes('text/plain')) {
                const blob = await item.getType('text/plain');
                existingText = await blob.text();
                break;
              }
            }
          } catch (e) {
            // 忽略读取错误
          }
        }
        
        // 合并内容
        const newText = existingText ? `${existingText}${separator}${text}` : text;
        
        // 写入剪贴板
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(newText);
        } else {
          const textarea = document.createElement('textarea');
          textarea.value = newText;
          textarea.style.position = 'fixed';
          textarea.style.opacity = '0';
          document.body.appendChild(textarea);
          textarea.select();
          document.execCommand('copy');
          document.body.removeChild(textarea);
        }
        
        sendResponse({ 
          success: true, 
          message: 'Content appended to clipboard',
          previousLength: existingText.length,
          appendedLength: text.length,
          totalLength: newText.length
        });
        
      } catch (error) {
        sendResponse({ error: error.message });
      }
    },

    // 清空剪贴板
    clear_clipboard: async () => {
      try {
        // 写入空字符串
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText('');
        } else {
          const textarea = document.createElement('textarea');
          textarea.value = '';
          textarea.style.position = 'fixed';
          textarea.style.opacity = '0';
          document.body.appendChild(textarea);
          textarea.select();
          document.execCommand('copy');
          document.body.removeChild(textarea);
        }
        
        sendResponse({ success: true, message: 'Clipboard cleared' });
        
      } catch (error) {
        sendResponse({ error: error.message });
      }
    },


    // 在 chrome.runtime.onMessage 的 handlers 中添加

    // 获取所有可点击元素
    get_clickable_elements: async () => {
      const { includePosition = true, includeSelector = true } = request;
      
      try {
        const clickableElements = extractClickableElements();
        const elements = [];
        
        for (let i = 0; i < clickableElements.length; i++) {
          const el = clickableElements[i];
          const rect = el.getBoundingClientRect();
          
          // 只收集可见的元素
          if (rect.width > 0 && rect.height > 0) {
            const elementInfo = {
              index: i,
              tag: el.tagName,
              type: el.type || null,
              text: getElementText(el),
              // 生成唯一选择器
              selector: includeSelector ? generateUniqueSelector(el) : null,
              // 位置信息
              position: includePosition ? {
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
                centerX: Math.round(rect.x + rect.width / 2),
                centerY: Math.round(rect.y + rect.height / 2)
              } : null,
              // 属性
              id: el.id || null,
              name: el.name || null,
              className: el.className || null,
              href: el.href || null,
              // 状态
              disabled: el.disabled || false,
              visible: true
            };
            
            elements.push(elementInfo);
          }
        }
        
        // 统计信息
        const summary = {
          byTag: {},
          byType: {},
          totalVisible: elements.length,
          totalFound: clickableElements.length
        };
        
        for (const el of elements) {
          // 按标签统计
          summary.byTag[el.tag] = (summary.byTag[el.tag] || 0) + 1;
          // 按类型统计（如果有）
          if (el.type) {
            summary.byType[el.type] = (summary.byType[el.type] || 0) + 1;
          }
        }
        
        sendResponse({
          success: true,
          total: elements.length,
          elements: elements,
          summary: summary
        });
        
      } catch (error) {
        sendResponse({ error: error.message });
      }
    },

    // 获取可点击元素（按类型分组）
    get_clickable_elements_grouped: async () => {
      try {
        const clickableElements = extractClickableElements();
        const groups = {
          buttons: [],
          links: [],
          inputs: [],
          divs: [],
          others: []
        };
        
        for (let i = 0; i < clickableElements.length; i++) {
          const el = clickableElements[i];
          const rect = el.getBoundingClientRect();
          
          if (rect.width > 0 && rect.height > 0) {
            const elementInfo = {
              index: i,
              tag: el.tagName,
              text: getElementText(el),
              selector: generateUniqueSelector(el),
              id: el.id || null,
              name: el.name || null,
              className: el.className || null,
              href: el.href || null,
              disabled: el.disabled || false,
              position: {
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
                centerX: Math.round(rect.x + rect.width / 2),
                centerY: Math.round(rect.y + rect.height / 2)
              }
            };
            
            // 按类型分组
            if (el.tagName === 'BUTTON') {
              groups.buttons.push(elementInfo);
            } else if (el.tagName === 'A' && el.href) {
              groups.links.push(elementInfo);
            } else if (el.tagName === 'INPUT' && (el.type === 'submit' || el.type === 'button' || el.type === 'reset')) {
              groups.inputs.push(elementInfo);
            } else if (el.tagName === 'DIV' && (el.onclick || el.getAttribute('role') === 'button')) {
              groups.divs.push(elementInfo);
            } else {
              groups.others.push(elementInfo);
            }
          }
        }
        
        const total = groups.buttons.length + groups.links.length + groups.inputs.length + groups.divs.length + groups.others.length;
        
        sendResponse({
          success: true,
          groups: groups,
          total: total,
          summary: {
            buttons: groups.buttons.length,
            links: groups.links.length,
            inputs: groups.inputs.length,
            divs: groups.divs.length,
            others: groups.others.length
          }
        });
        
      } catch (error) {
        sendResponse({ error: error.message });
      }
    },

    // 获取可点击元素的简化选择器列表
    get_clickable_element_selectors: async () => {
      try {
        const clickableElements = extractClickableElements();
        const selectors = [];
        
        for (let i = 0; i < clickableElements.length; i++) {
          const el = clickableElements[i];
          const rect = el.getBoundingClientRect();
          
          if (rect.width > 0 && rect.height > 0) {
            selectors.push({
              index: i,
              selector: generateUniqueSelector(el),
              tag: el.tagName,
              text: getElementText(el).substring(0, 50)
            });
          }
        }
        
        sendResponse({
          success: true,
          selectors: selectors,
          total: selectors.length
        });
        
      } catch (error) {
        sendResponse({ error: error.message });
      }
    },



  };
  
  const handler = handlers[request.action];
  if (handler) {
    handler();
  } else {
    sendResponse({ error: `Unknown action: ${request.action}` });
  }
  
  return true; // 保持消息通道开放
});

// ============ 机灵回复函数 ============
async function callSmartReply(text, context) {
  try {
    const payload = {
      dtnsbot_secret_key: SECRET_KEY,
      user_id: USER_ID,
      layout: text,
      context: context || "浏览器插件调用",
      system_prompt: "你是一个机灵幽默的AI助手，根据内容生成一段简短、有趣的回复。直接输出回复内容。"
    };
    
    const response = await fetch(SMART_REPLY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) throw new Error(`API错误 ${response.status}`);
    const data = await response.json();
    
    let replyText = '';
    if (typeof data === 'string') replyText = data;
    else if (data.reply) replyText = data.reply;
    else if (data.data?.reply) replyText = data.data.reply;
    else replyText = JSON.stringify(data);
    
    // 复制到剪贴板（navigator.clipboard 在非聚焦/非安全上下文下可能不存在，
    // 直接调用会抛 TypeError，这里做能力检测而不是只依赖 try/catch）
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(replyText);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = replyText;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
    } catch (e) {
      console.warn('复制失败:', e && e.message);
    }
    
    return { success: true, reply: replyText };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ============ 选区UI（保持不变） ============
function createOverlay() {
  if (selectionOverlay) return;
  
  selectionOverlay = document.createElement('div');
  selectionOverlay.id = 'ai-pony-selector-overlay';
  selectionOverlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.5);
    z-index: 999999;
    cursor: crosshair;
    user-select: none;
  `;
  
  const tip = document.createElement('div');
  tip.textContent = '🦄 拖动鼠标选择区域 → 松开即发送机灵回复 | ESC 取消';
  tip.style.cssText = `
    position: fixed;
    top: 20px;
    left: 50%;
    transform: translateX(-50%);
    background: #1e1f2c;
    color: white;
    padding: 10px 20px;
    border-radius: 40px;
    font-size: 14px;
    font-weight: bold;
    z-index: 1000000;
    pointer-events: none;
  `;
  selectionOverlay.appendChild(tip);
  
  selectionRect = document.createElement('div');
  selectionRect.style.cssText = `
    position: fixed;
    border: 3px solid #60a5fa;
    background: rgba(96, 165, 250, 0.2);
    pointer-events: none;
    display: none;
    z-index: 1000000;
  `;
  selectionOverlay.appendChild(selectionRect);
  
  document.body.appendChild(selectionOverlay);
  
  selectionOverlay.addEventListener('mousedown', onMouseDown);
  selectionOverlay.addEventListener('mousemove', onMouseMove);
  selectionOverlay.addEventListener('mouseup', onMouseUp);
  document.addEventListener('keydown', onKeyDown);
}

function onMouseDown(e) {
  if (!isSelecting) {
    isSelecting = true;
    startPoint = { x: e.clientX, y: e.clientY };
    endPoint = { x: e.clientX, y: e.clientY };
    selectionRect.style.display = 'block';
    updateSelectionRect();
  }
}

function onMouseMove(e) {
  if (isSelecting) {
    endPoint = { x: e.clientX, y: e.clientY };
    updateSelectionRect();
  }
}

function onMouseUp(e) {
  if (isSelecting) {
    isSelecting = false;
    const rect = getNormalizedRect();
    if (rect.width > 10 && rect.height > 10) {
      const selectedHtml = extractHtmlFromRect(rect);
      if (selectedHtml && selectedHtml.trim()) {
        const text = extractTextFromHtml(selectedHtml);
        callSmartReply(text, '网页选区内容');
        showTipMessage('🤔 正在生成机灵回复...');
      } else {
        showTipMessage('未提取到有效内容');
      }
    } else {
      showTipMessage('选区太小，请重新选择');
    }
    removeOverlay();
  }
}

function updateSelectionRect() {
  const left = Math.min(startPoint.x, endPoint.x);
  const top = Math.min(startPoint.y, endPoint.y);
  const width = Math.abs(endPoint.x - startPoint.x);
  const height = Math.abs(endPoint.y - startPoint.y);
  selectionRect.style.left = left + 'px';
  selectionRect.style.top = top + 'px';
  selectionRect.style.width = width + 'px';
  selectionRect.style.height = height + 'px';
}

function getNormalizedRect() {
  return {
    left: Math.min(startPoint.x, endPoint.x),
    top: Math.min(startPoint.y, endPoint.y),
    width: Math.abs(endPoint.x - startPoint.x),
    height: Math.abs(endPoint.y - startPoint.y)
  };
}

function extractHtmlFromRect(rect) {
  const elements = [];
  const allElements = document.body.getElementsByTagName('*');
  
  for (let el of allElements) {
    const elRect = el.getBoundingClientRect();
    if (elRect.right > rect.left && elRect.left < rect.left + rect.width &&
        elRect.bottom > rect.top && elRect.top < rect.top + rect.height) {
      elements.push(el);
    }
  }
  
  if (elements.length === 0) return '';
  
  const container = document.createElement('div');
  const uniqueElements = new Set(elements);
  const topLevel = [];
  
  for (let el of uniqueElements) {
    let parentInSet = false;
    let parent = el.parentElement;
    while (parent) {
      if (uniqueElements.has(parent)) {
        parentInSet = true;
        break;
      }
      parent = parent.parentElement;
    }
    if (!parentInSet) {
      topLevel.push(el);
    }
  }
  
  topLevel.forEach(el => {
    container.appendChild(el.cloneNode(true));
  });
  
  return container.innerHTML;
}

function extractTextFromHtml(html) {
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = html;
  return tempDiv.textContent || tempDiv.innerText || '';
}

function removeOverlay() {
  if (selectionOverlay) {
    selectionOverlay.removeEventListener('mousedown', onMouseDown);
    selectionOverlay.removeEventListener('mousemove', onMouseMove);
    selectionOverlay.removeEventListener('mouseup', onMouseUp);
    document.removeEventListener('keydown', onKeyDown);
    selectionOverlay.remove();
    selectionOverlay = null;
    selectionRect = null;
  }
  isSelecting = false;
}

function onKeyDown(e) {
  if (e.key === 'Escape') {
    removeOverlay();
    showTipMessage('已取消', 1000);
  }
}

function showTipMessage(msg, duration = 2000) {
  const tip = document.createElement('div');
  tip.textContent = msg;
  tip.style.cssText = `
    position: fixed;
    bottom: 30px;
    left: 50%;
    transform: translateX(-50%);
    background: #1f2937;
    color: white;
    padding: 8px 20px;
    border-radius: 40px;
    font-size: 14px;
    z-index: 10000000;
    font-weight: bold;
    pointer-events: none;
  `;
  document.body.appendChild(tip);
  setTimeout(() => tip.remove(), duration);
}

// 提取页面元素信息（完整版）
function extractPageElements(element, depth = 0, maxDepth = 10) {
  if (depth > maxDepth) return null;
  
  const rect = element.getBoundingClientRect();
  const computedStyle = window.getComputedStyle(element);
  
  const elementInfo = {
    tag: element.tagName,
    id: element.id || null,
    className: element.className || null,
    type: element.type || null,
    // 位置信息
    position: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    },
    // 可见性
    visible: isElementVisible(element),
    // 文本内容（限制长度）
    text: element.textContent?.trim()?.substring(0, 200) || null,
    // 子元素
    children: []
  };
  
  // 添加特定属性
  if (element.href) elementInfo.href = element.href;
  if (element.src) elementInfo.src = element.src;
  if (element.value) elementInfo.value = element.value?.substring(0, 100);
  if (element.placeholder) elementInfo.placeholder = element.placeholder;
  if (element.name) elementInfo.name = element.name;
  if (element.alt) elementInfo.alt = element.alt;
  if (element.title) elementInfo.title = element.title;
  
  // 递归处理子元素（限制数量）
  const children = Array.from(element.children);
  const maxChildren = 50;
  for (let i = 0; i < Math.min(children.length, maxChildren); i++) {
    const childInfo = extractPageElements(children[i], depth + 1, maxDepth);
    if (childInfo) {
      elementInfo.children.push(childInfo);
    }
  }
  
  return elementInfo;
}

// 提取精简的页面元素信息
function extractPageElementsSimple(element) {
  const elements = [];
  const allElements = document.querySelectorAll('*');
  
  for (let el of allElements) {
    // 限制数量，避免返回过多数据
    if (elements.length >= 500) break;
    
    const rect = el.getBoundingClientRect();
    // 只返回可见且有一定大小的元素
    if (rect.width > 0 && rect.height > 0) {
      elements.push({
        tag: el.tagName,
        id: el.id || null,
        className: el.className || null,
        type: el.type || null,
        text: el.textContent?.trim()?.substring(0, 100) || null,
        href: el.href || null,
        src: el.src || null,
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      });
    }
  }
  
  return elements;
}

// 获取元素属性
function getElementAttributes(element) {
  const attrs = {};
  for (let i = 0; i < element.attributes.length; i++) {
    const attr = element.attributes[i];
    attrs[attr.name] = attr.value;
  }
  return attrs;
}

// 判断元素是否可见
function isElementVisible(element) {
  if (!element) return false;
  
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  
  return rect.width > 0 && 
         rect.height > 0 && 
         style.display !== 'none' && 
         style.visibility !== 'hidden' &&
         style.opacity !== '0';
}

// 统计元素数量
function countElements(elements) {
  let count = 1;
  if (elements.children) {
    for (const child of elements.children) {
      count += countElements(child);
    }
  }
  return count;
}

// 提取页面可见文本块（带位置信息）
function extractVisibleTextBlocks() {
  const textBlocks = [];
  
  // 获取所有包含文本的元素
  const textNodes = getVisibleTextNodes();
  
  // 按位置分组合并相邻的文本节点
  const mergedBlocks = mergeTextNodesByPosition(textNodes);
  
  // 转换为带位置信息的文本块
  for (const block of mergedBlocks) {
    if (block.text && block.text.trim().length > 0) {
      textBlocks.push({
        text: block.text.trim(),
        position: block.position,
        boundingBox: block.boundingBox,
        element: {
          tag: block.tagName,
          id: block.id || null,
          className: block.className || null
        }
      });
    }
  }
  
  return textBlocks;
}

// 获取所有可见的文本节点
function getVisibleTextNodes() {
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: function(node) {
        // 过滤空白节点
        if (!node.textContent || !node.textContent.trim()) {
          return NodeFilter.FILTER_REJECT;
        }
        
        // 检查父元素是否可见
        const parent = node.parentElement;
        if (!parent || !isElementVisible(parent)) {
          return NodeFilter.FILTER_REJECT;
        }
        
        // 过滤脚本、样式等标签内的文本
        const invisibleTags = ['SCRIPT', 'STYLE', 'NOSCRIPT', 'META', 'LINK'];
        if (invisibleTags.includes(parent.tagName)) {
          return NodeFilter.FILTER_REJECT;
        }
        
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );
  
  const textNodes = [];
  let node;
  while (node = walker.nextNode()) {
    const rect = node.parentElement.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      textNodes.push({
        node: node,
        text: node.textContent.trim(),
        parent: node.parentElement,
        rect: rect
      });
    }
  }
  
  return textNodes;
}

// 按位置合并文本节点
function mergeTextNodesByPosition(textNodes) {
  if (textNodes.length === 0) return [];
  
  const merged = [];
  let currentBlock = null;
  
  for (const node of textNodes) {
    if (!currentBlock) {
      // 开始新的文本块
      currentBlock = {
        text: node.text,
        position: {
          x: Math.round(node.rect.x),
          y: Math.round(node.rect.y)
        },
        boundingBox: {
          x: Math.round(node.rect.x),
          y: Math.round(node.rect.y),
          width: Math.round(node.rect.width),
          height: Math.round(node.rect.height),
          top: Math.round(node.rect.top),
          bottom: Math.round(node.rect.bottom),
          left: Math.round(node.rect.left),
          right: Math.round(node.rect.right)
        },
        tagName: node.parent.tagName,
        id: node.parent.id,
        className: node.parent.className
      };
    } else {
      // 检查是否与当前块相邻（垂直距离小于行高的1.5倍）
      const verticalDistance = Math.abs(node.rect.y - currentBlock.boundingBox.y);
      const lineHeight = parseInt(window.getComputedStyle(node.parent).lineHeight) || 20;
      const isSameLine = Math.abs(node.rect.y - currentBlock.boundingBox.y) < lineHeight;
      const isNearby = verticalDistance < lineHeight * 1.5;
      
      if (isSameLine) {
        // 同一行，水平合并
        currentBlock.text += ' ' + node.text;
        // 更新边界框
        currentBlock.boundingBox.width = Math.max(
          currentBlock.boundingBox.width,
          node.rect.x + node.rect.width - currentBlock.boundingBox.x
        );
        currentBlock.boundingBox.right = Math.max(currentBlock.boundingBox.right, Math.round(node.rect.right));
      } else if (isNearby) {
        // 相邻行，换行合并
        currentBlock.text += '\n' + node.text;
        // 更新边界框
        currentBlock.boundingBox.height = node.rect.y + node.rect.height - currentBlock.boundingBox.y;
        currentBlock.boundingBox.bottom = Math.max(currentBlock.boundingBox.bottom, Math.round(node.rect.bottom));
      } else {
        // 距离太远，保存当前块，开始新块
        merged.push(currentBlock);
        currentBlock = {
          text: node.text,
          position: {
            x: Math.round(node.rect.x),
            y: Math.round(node.rect.y)
          },
          boundingBox: {
            x: Math.round(node.rect.x),
            y: Math.round(node.rect.y),
            width: Math.round(node.rect.width),
            height: Math.round(node.rect.height),
            top: Math.round(node.rect.top),
            bottom: Math.round(node.rect.bottom),
            left: Math.round(node.rect.left),
            right: Math.round(node.rect.right)
          },
          tagName: node.parent.tagName,
          id: node.parent.id,
          className: node.parent.className
        };
      }
    }
  }
  
  // 添加最后一个块
  if (currentBlock) {
    merged.push(currentBlock);
  }
  
  return merged;
}

// 获取页面可见文本（简化版，只返回合并的纯文本）
function getVisibleTextMerged(separator = '\n') {
  const textBlocks = extractVisibleTextBlocks();
  return textBlocks.map(block => block.text).join(separator);
}

// 判断元素是否可见（增强版）
function isElementVisible(element) {
  if (!element) return false;
  
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  
  // 基本可见性检查
  if (rect.width <= 0 || rect.height <= 0) return false;
  if (style.display === 'none') return false;
  if (style.visibility === 'hidden') return false;
  if (style.opacity === '0') return false;
  
  // 检查是否在视口内
  const viewportHeight = window.innerHeight;
  const viewportWidth = window.innerWidth;
  const isInViewport = rect.top < viewportHeight && rect.bottom > 0 && 
                       rect.left < viewportWidth && rect.right > 0;
  
  // 如果不在视口内但可能通过滚动可见，仍然认为是可见的
  // 只过滤掉完全不可见的元素
  return true;
}

// 截取可见标签页
// 截图功能 - 使用background的缓存机制
async function captureVisibleTab(forceRefresh = false) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ 
      action: 'capture_tab',
      format: 'png',
      quality: 90,
      forceRefresh: forceRefresh
    }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response && response.error) {
        reject(new Error(response.error));
      } else if (response && response.imageData) {
        resolve(response);
      } else {
        reject(new Error('Failed to capture screenshot'));
      }
    });
  });
}

// 截取整个页面（滚动截图）
async function captureFullPage() {
  const originalScrollX = window.scrollX;
  const originalScrollY = window.scrollY;
  
  const scrollWidth = document.documentElement.scrollWidth;
  const scrollHeight = document.documentElement.scrollHeight;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  
  const columns = Math.ceil(scrollWidth / viewportWidth);
  const rows = Math.ceil(scrollHeight / viewportHeight);
  
  const screenshots = [];
  
  // 滚动并截取每个区域
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const scrollX = x * viewportWidth;
      const scrollY = y * viewportHeight;
      
      window.scrollTo(scrollX, scrollY);
      await sleep(200); // 等待滚动完成
      
      const screenshot = await captureVisibleTab();
      screenshots.push({
        x: scrollX,
        y: scrollY,
        width: viewportWidth,
        height: viewportHeight,
        data: screenshot
      });
    }
  }
  
  // 恢复原始滚动位置
  window.scrollTo(originalScrollX, originalScrollY);
  
  return {
    type: 'fullpage',
    screenshots: screenshots,
    totalWidth: scrollWidth,
    totalHeight: scrollHeight,
    viewportWidth: viewportWidth,
    viewportHeight: viewportHeight
  };
}

// 截取指定区域
async function captureRegion(region) {
  const { x, y, width, height } = region;
  
  // 保存当前滚动位置
  const originalScrollX = window.scrollX;
  const originalScrollY = window.scrollY;
  
  // 滚动到目标区域
  window.scrollTo(x, y);
  await sleep(100);
  
  // 截取当前视口
  const screenshot = await captureVisibleTab();
  
  // 恢复滚动位置
  window.scrollTo(originalScrollX, originalScrollY);
  
  return {
    type: 'region',
    region: { x, y, width, height },
    data: screenshot
  };
}


// 提取所有可点击元素
function extractClickableElements() {
  const clickableSelectors = [
    'button',
    'a[href]',
    'input[type="button"]',
    'input[type="submit"]',
    'input[type="reset"]',
    'input[type="image"]',
    '[onclick]',
    '[role="button"]',
    '[tabindex="0"]',
    'div[class*="btn"]',
    'span[class*="btn"]',
    '.btn',
    '.button',
    '[class*="clickable"]',
    '[data-click]',
    '[ng-click]',
    '@click',
    'area[href]'
  ];
  
  const elements = new Set();
  
  for (const selector of clickableSelectors) {
    try {
      const found = document.querySelectorAll(selector);
      for (const el of found) {
        elements.add(el);
      }
    } catch (e) {
      // 忽略无效选择器
    }
  }
  
  // 额外检查：有 cursor: pointer 样式的元素
  const allElements = document.querySelectorAll('*');
  for (const el of allElements) {
    const style = window.getComputedStyle(el);
    if (style.cursor === 'pointer') {
      elements.add(el);
    }
  }
  
  return Array.from(elements);
}

// 获取元素文本内容（优先使用可见文本）
function getElementText(element) {
  // 对于 input 元素，获取 value
  if (element.tagName === 'INPUT' && element.value) {
    return element.value;
  }
  
  // 获取文本内容
  let text = element.textContent || element.innerText || '';
  text = text.trim();
  
  // 限制长度
  if (text.length > 100) {
    text = text.substring(0, 100) + '...';
  }
  
  return text || (element.alt || element.title || '');
}

// 生成唯一的 CSS 选择器
function generateUniqueSelector(element) {
  if (!element) return null;
  
  // 优先使用 id
  if (element.id) {
    return `#${element.id}`;
  }
  
  // 使用 name 属性
  if (element.name) {
    const selector = `${element.tagName.toLowerCase()}[name="${element.name}"]`;
    if (document.querySelectorAll(selector).length === 1) {
      return selector;
    }
  }
  
  // 使用 class 组合
  if (element.className && typeof element.className === 'string') {
    const classes = element.className.trim().split(/\s+/);
    for (let i = classes.length; i > 0; i--) {
      const selector = `${element.tagName.toLowerCase()}.${classes.slice(0, i).join('.')}`;
      if (document.querySelectorAll(selector).length === 1) {
        return selector;
      }
    }
  }
  
  // 使用 nth-child 或 nth-of-type
  const parent = element.parentElement;
  if (parent) {
    const siblings = Array.from(parent.children);
    const sameTagSiblings = siblings.filter(s => s.tagName === element.tagName);
    const index = siblings.indexOf(element) + 1;
    const sameTagIndex = sameTagSiblings.indexOf(element) + 1;
    
    if (sameTagSiblings.length === 1) {
      return `${element.tagName.toLowerCase()}:nth-of-type(${sameTagIndex})`;
    }
    return `${element.tagName.toLowerCase()}:nth-child(${index})`;
  }
  
  // 返回标签名
  return element.tagName.toLowerCase();
}

// ============ 控制台日志拦截（用于页面内收集） ============

// 拦截控制台日志并保存到页面变量中，以便 API 查询
(function setupConsoleCapture() {
  if (window.__console_capture_installed__) return;
  window.__console_capture_installed__ = true;
  
  // 初始化日志存储
  if (!window.__console_logs__) {
    window.__console_logs__ = [];
  }
  
  // 保存原始方法
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const originalInfo = console.info;
  const originalDebug = console.debug;
  
  // 添加日志函数
  function addLog(level, args) {
    const message = Array.from(args).map(arg => {
      try {
        if (typeof arg === 'object') {
          return JSON.stringify(arg);
        }
        return String(arg);
      } catch(e) {
        return String(arg);
      }
    }).join(' ');
    
    window.__console_logs__.push({
      level: level,
      message: message,
      timestamp: Date.now(),
      url: window.location.href
    });
    
    // 限制存储数量
    if (window.__console_logs__.length > 1000) {
      window.__console_logs__ = window.__console_logs__.slice(-500);
    }
  }
  
  // 重写控制台方法
  console.log = function(...args) {
    addLog('log', args);
    originalLog.apply(console, args);
  };
  
  console.error = function(...args) {
    addLog('error', args);
    originalError.apply(console, args);
  };
  
  console.warn = function(...args) {
    addLog('warn', args);
    originalWarn.apply(console, args);
  };
  
  console.info = function(...args) {
    addLog('info', args);
    originalInfo.apply(console, args);
  };
  
  console.debug = function(...args) {
    addLog('debug', args);
    originalDebug.apply(console, args);
  };
  
  // 监听未捕获的错误
  window.addEventListener('error', (event) => {
    window.__console_logs__.push({
      level: 'error',
      message: `Uncaught: ${event.message} at ${event.filename}:${event.lineno}`,
      timestamp: Date.now(),
      url: window.location.href
    });
  });
  
  // 监听 Promise 拒绝
  window.addEventListener('unhandledrejection', (event) => {
    window.__console_logs__.push({
      level: 'error',
      message: `Unhandled Promise Rejection: ${event.reason}`,
      timestamp: Date.now(),
      url: window.location.href
    });
  });
  
  console.log('[Content] 控制台日志拦截已启动');
})();

// 辅助函数：获取视口信息
function getViewportInfo() {
  return {
    scrollX: window.scrollX || window.pageXOffset,
    scrollY: window.scrollY || window.pageYOffset,
    clientWidth: document.documentElement.clientWidth,
    clientHeight: document.documentElement.clientHeight,
    visualViewport: window.visualViewport ? {
      width: window.visualViewport.width,
      height: window.visualViewport.height,
      scale: window.visualViewport.scale
    } : null
  };
}

// 辅助函数：将页面坐标转换为视口坐标
function pageToViewport(pageX, pageY) {
  const viewport = getViewportInfo();
  return {
    x: pageX - viewport.scrollX,
    y: pageY - viewport.scrollY
  };
}

// 辅助函数：将视口坐标转换为页面坐标
function viewportToPage(clientX, clientY) {
  const viewport = getViewportInfo();
  return {
    x: clientX + viewport.scrollX,
    y: clientY + viewport.scrollY
  };
}

// 辅助函数：获取元素相对于文档的精确位置
function getElementDocumentPosition(element) {
  const rect = element.getBoundingClientRect();
  const scrollX = window.scrollX || window.pageXOffset;
  const scrollY = window.scrollY || window.pageYOffset;
  
  return {
    left: rect.left + scrollX,
    top: rect.top + scrollY,
    right: rect.right + scrollX,
    bottom: rect.bottom + scrollY,
    width: rect.width,
    height: rect.height,
    centerX: rect.left + rect.width / 2 + scrollX,
    centerY: rect.top + rect.height / 2 + scrollY
  };
}

// 辅助函数
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 快捷键 Alt+S
document.addEventListener('keydown', (e) => {
  if (e.altKey && e.key === 's') {
    e.preventDefault();
    if (selectionOverlay) removeOverlay();
    createOverlay();
  }
});

console.log('[Content] AI灵驹内容脚本已加载');