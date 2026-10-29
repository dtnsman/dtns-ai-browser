// popup.js
const startBtn = document.getElementById('startSmartBtn');
const apiUrlSpan = document.getElementById('apiUrl');
const apiUrlContainer = document.getElementById('apiUrlContainer');
const copyApiUrlBtn = document.getElementById('copyApiUrlBtn');
const openApiUrlBtn = document.getElementById('openApiUrlBtn');
const statusMsg = document.getElementById('statusMsg');
const registerStatusSpan = document.getElementById('registerStatus');
const apiStatusSpan = document.getElementById('apiStatus');

let currentApiUrl = '';

// 显示提示消息
function showToast(message, isError = false) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  toast.style.background = isError ? '#ef4444' : '#10b981';
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2000);
}

// 复制到剪贴板
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast('✅ 已复制到剪贴板');
    return true;
  } catch (error) {
    showToast('❌ 复制失败: ' + error.message, true);
    return false;
  }
}

// 打开URL在新标签页
function openUrlInNewTab(url) {
  if (!url || url === '加载中...') {
    showToast('❌ API地址未就绪', true);
    return;
  }
  chrome.tabs.create({ url: url });
  showToast('🔗 已在新标签页打开');
}

// 更新状态徽章样式
function updateStatusBadge(status, isConnected) {
  registerStatusSpan.className = 'status-badge';
  if (isConnected && status === 'registered') {
    registerStatusSpan.classList.add('connected');
    registerStatusSpan.textContent = '✅ 已连接';
  } else if (isConnected) {
    registerStatusSpan.classList.add('connecting');
    registerStatusSpan.textContent = '⏳ 连接中';
  } else {
    registerStatusSpan.classList.add('disconnected');
    registerStatusSpan.textContent = '❌ 离线';
  }
}

// 加载连接状态
async function loadConnectionStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'getConnectionStatus' });
    
    if (response) {
      const { connected, clientId, browserDomain, registered, registeredDomains } = response;
      
      if (connected && browserDomain) {
        let browserDomains = browserDomain.split('.')
        browserDomains[1] = browserDomains[1].substring(0,6)+'***'
        currentApiUrl = `http://${browserDomain}`;
        apiUrlSpan.textContent = `http://${browserDomains.join('.')}`;
        apiStatusSpan.textContent = '✅ 在线';
        
        if (registered) {
          updateStatusBadge('registered', true);
          statusMsg.innerHTML = '✅ 服务已就绪，可通过HTTP API远程控制浏览器<br>📍 点击上方地址可打开API文档';
        } else {
          updateStatusBadge('connecting', true);
          statusMsg.innerHTML = '⏳ 正在向服务器注册域名，请稍候...';
        }
      } else {
        currentApiUrl = '';
        apiUrlSpan.textContent = '连接中...';
        apiStatusSpan.textContent = '🔌 离线';
        updateStatusBadge('disconnected', false);
        statusMsg.innerHTML = '🔌 正在连接隧道服务器...<br>请确保网络正常';
      }
    }
  } catch (error) {
    console.error('获取连接状态失败:', error);
    currentApiUrl = '';
    apiUrlSpan.textContent = '连接失败';
    apiStatusSpan.textContent = '❌ 错误';
    updateStatusBadge('disconnected', false);
    statusMsg.innerHTML = '❌ 连接失败，请重新加载插件';
  }
}

// 启动选区
startBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    statusMsg.innerHTML = '❌ 未找到活动标签页';
    return;
  }
  
  chrome.tabs.sendMessage(tab.id, { action: 'startSmartSelect' }, (response) => {
    if (chrome.runtime.lastError) {
      statusMsg.innerHTML = '❌ 无法与页面通信，请刷新页面后重试';
    } else {
      statusMsg.innerHTML = '🔍 选区模式已启动！在页面上拖动鼠标选择区域';
      setTimeout(() => {
        window.close();
      }, 1500);
    }
  });
});

// 复制API地址
copyApiUrlBtn.addEventListener('click', async () => {
  if (currentApiUrl) {
    await copyToClipboard(currentApiUrl);
  } else {
    showToast('❌ API地址未就绪', true);
  }
});

// 打开API地址
openApiUrlBtn.addEventListener('click', () => {
  if (currentApiUrl) {
    // 打开机器可读的端点目录，Agent / 低代码平台可直接导入
    openUrlInNewTab(currentApiUrl + '/api.json');
  } else {
    showToast('❌ API地址未就绪', true);
  }
});

// 双击API地址也可以复制
apiUrlContainer.addEventListener('dblclick', async () => {
  if (currentApiUrl) {
    await copyToClipboard(currentApiUrl);
  }
});

// popup.js - 在现有代码末尾添加以下内容

// ============ 新增：配置管理 ============

// DOM 元素
const configToggleBtn = document.getElementById('configToggleBtn');
const configPanel = document.getElementById('configPanel');
const clientIdInput = document.getElementById('clientIdInput');
const saveClientIdBtn = document.getElementById('saveClientIdBtn');
const generateClientIdBtn = document.getElementById('generateClientIdBtn');
const serverUrlInput = document.getElementById('serverUrlInput');
const saveServerUrlBtn = document.getElementById('saveServerUrlBtn');
const resetConfigBtn = document.getElementById('resetConfigBtn');
const reconnectBtn = document.getElementById('reconnectBtn');
const closeConfigBtn = document.getElementById('closeConfigBtn');
const configStatusMsg = document.getElementById('configStatusMsg');

// 配置面板开关
if (configToggleBtn) {
  configToggleBtn.addEventListener('click', () => {
    if (configPanel.style.display === 'none') {
      configPanel.style.display = 'block';
      loadConfigData();
    } else {
      configPanel.style.display = 'none';
    }
  });
}

// 关闭配置面板
if (closeConfigBtn) {
  closeConfigBtn.addEventListener('click', () => {
    configPanel.style.display = 'none';
  });
}

// 加载配置数据
async function loadConfigData() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'getConfig' });
    if (response) {
      if (clientIdInput) clientIdInput.value = response.clientId || '';
      if (serverUrlInput) serverUrlInput.value = response.wsServerUrl || '';
    }
  } catch (error) {
    console.error('加载配置失败:', error);
    showToast('❌ 加载配置失败', true);
  }
}

// 保存客户端ID
if (saveClientIdBtn) {
  saveClientIdBtn.addEventListener('click', async () => {
    const newClientId = clientIdInput.value.trim();
    if (!newClientId) {
      showToast('❌ 请输入有效的客户端ID', true);
      return;
    }
    
    // 验证格式（只允许字母数字）
    if (!/^[a-zA-Z0-9]+$/.test(newClientId)) {
      showToast('❌ 客户端ID只能包含字母和数字', true);
      return;
    }
    
    saveClientIdBtn.disabled = true;
    saveClientIdBtn.textContent = '保存中...';
    
    try {
      const response = await chrome.runtime.sendMessage({ 
        action: 'setClientId', 
        clientId: newClientId 
      });
      
      if (response && response.success) {
        showToast(`✅ 客户端ID已更改为 ${newClientId}，正在重连...`);
        if (configStatusMsg) {
          configStatusMsg.innerHTML = `✅ 已更改客户端ID为 ${newClientId}，正在重新连接服务器...`;
          configStatusMsg.style.color = '#10b981';
        }
        // 延迟刷新状态
        setTimeout(() => {
          loadConnectionStatus();
          loadConfigData();
          if (configStatusMsg) {
            setTimeout(() => {
              configStatusMsg.innerHTML = '';
            }, 3000);
          }
        }, 2000);
      } else {
        showToast(`❌ 更改失败: ${response?.error || '未知错误'}`, true);
        if (configStatusMsg) {
          configStatusMsg.innerHTML = `❌ 更改失败: ${response?.error || '未知错误'}`;
          configStatusMsg.style.color = '#ef4444';
        }
      }
    } catch (error) {
      console.error('保存客户端ID失败:', error);
      showToast('❌ 保存失败: ' + error.message, true);
    } finally {
      saveClientIdBtn.disabled = false;
      saveClientIdBtn.textContent = '保存';
    }
  });
}

// 生成新的客户端ID
if (generateClientIdBtn) {
  generateClientIdBtn.addEventListener('click', async () => {
    generateClientIdBtn.disabled = true;
    generateClientIdBtn.textContent = '生成中...';
    
    try {
      const response = await chrome.runtime.sendMessage({ action: 'generateNewClientId' });
      
      if (response && response.success) {
        const newId = response.clientId;
        if (clientIdInput) clientIdInput.value = newId;
        showToast(`✅ 已生成新ID: ${newId}`);
        if (configStatusMsg) {
          configStatusMsg.innerHTML = `✅ 已生成新ID: ${newId}，正在重连...`;
          configStatusMsg.style.color = '#10b981';
        }
        setTimeout(() => {
          loadConnectionStatus();
          if (configStatusMsg) {
            setTimeout(() => {
              configStatusMsg.innerHTML = '';
            }, 3000);
          }
        }, 2000);
      } else {
        showToast(`❌ 生成失败: ${response?.error || '未知错误'}`, true);
      }
    } catch (error) {
      console.error('生成客户端ID失败:', error);
      showToast('❌ 生成失败: ' + error.message, true);
    } finally {
      generateClientIdBtn.disabled = false;
      generateClientIdBtn.textContent = '生成新ID';
    }
  });
}

// 保存服务器地址
if (saveServerUrlBtn) {
  saveServerUrlBtn.addEventListener('click', async () => {
    const newUrl = serverUrlInput.value.trim();
    if (!newUrl) {
      showToast('❌ 请输入服务器地址', true);
      return;
    }
    
    // 验证URL格式
    if (!newUrl.startsWith('ws://') && !newUrl.startsWith('wss://')) {
      showToast('❌ 地址必须以 ws:// 或 wss:// 开头', true);
      return;
    }
    
    saveServerUrlBtn.disabled = true;
    saveServerUrlBtn.textContent = '保存中...';
    
    try {
      const response = await chrome.runtime.sendMessage({ 
        action: 'setServerUrl', 
        url: newUrl 
      });
      
      if (response && response.success) {
        showToast(`✅ 服务器地址已更改为 ${newUrl}，正在重连...`);
        if (configStatusMsg) {
          configStatusMsg.innerHTML = `✅ 已更改服务器地址为 ${newUrl}，正在重新连接...`;
          configStatusMsg.style.color = '#10b981';
        }
        setTimeout(() => {
          loadConnectionStatus();
          if (configStatusMsg) {
            setTimeout(() => {
              configStatusMsg.innerHTML = '';
            }, 3000);
          }
        }, 2000);
      } else {
        showToast(`❌ 更改失败: ${response?.error || '未知错误'}`, true);
      }
    } catch (error) {
      console.error('保存服务器地址失败:', error);
      showToast('❌ 保存失败: ' + error.message, true);
    } finally {
      saveServerUrlBtn.disabled = false;
      saveServerUrlBtn.textContent = '保存';
    }
  });
}

// 重置配置
if (resetConfigBtn) {
  resetConfigBtn.addEventListener('click', async () => {
    if (!confirm('重置配置将清除自定义的客户端ID和服务器地址，确定吗？')) return;
    
    resetConfigBtn.disabled = true;
    resetConfigBtn.textContent = '重置中...';
    
    try {
      const response = await chrome.runtime.sendMessage({ action: 'resetConfig' });
      
      if (response && response.success) {
        if (clientIdInput) clientIdInput.value = response.clientId;
        if (serverUrlInput) serverUrlInput.value = response.wsServerUrl;
        showToast('✅ 配置已重置，正在重连...');
        if (configStatusMsg) {
          configStatusMsg.innerHTML = '✅ 配置已重置，正在重新连接...';
          configStatusMsg.style.color = '#10b981';
        }
        setTimeout(() => {
          loadConnectionStatus();
          if (configStatusMsg) {
            setTimeout(() => {
              configStatusMsg.innerHTML = '';
            }, 3000);
          }
        }, 2000);
      } else {
        showToast('❌ 重置失败', true);
      }
    } catch (error) {
      console.error('重置配置失败:', error);
      showToast('❌ 重置失败: ' + error.message, true);
    } finally {
      resetConfigBtn.disabled = false;
      resetConfigBtn.textContent = '重置配置';
    }
  });
}

// 强制重连
if (reconnectBtn) {
  reconnectBtn.addEventListener('click', async () => {
    reconnectBtn.disabled = true;
    reconnectBtn.textContent = '重连中...';
    
    try {
      const response = await chrome.runtime.sendMessage({ action: 'reconnect' });
      
      if (response && response.success) {
        showToast('✅ 正在重新连接...');
        if (configStatusMsg) {
          configStatusMsg.innerHTML = '✅ 正在重新连接服务器...';
          configStatusMsg.style.color = '#10b981';
        }
        setTimeout(() => {
          loadConnectionStatus();
          if (configStatusMsg) {
            setTimeout(() => {
              configStatusMsg.innerHTML = '';
            }, 3000);
          }
        }, 2000);
      } else {
        showToast(`❌ 重连失败: ${response?.error || '未知错误'}`, true);
      }
    } catch (error) {
      console.error('重连失败:', error);
      showToast('❌ 重连失败: ' + error.message, true);
    } finally {
      reconnectBtn.disabled = false;
      reconnectBtn.textContent = '强制重连';
    }
  });
}

// 初始化配置面板状态
if (configPanel) {
  configPanel.style.display = 'none';
}

// 定期更新状态
loadConnectionStatus();
setInterval(loadConnectionStatus, 3000);