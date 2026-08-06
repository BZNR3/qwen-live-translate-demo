# 免费中英会议字幕 Demo（本地 MLX + Qwen3）

这是一个已经可以运行的小型中英语音翻译 Demo。它能采集麦克风，或用户主动共享的 Chrome 会议/视频标签页音频，在网页中显示原文和译文。

默认模式完全在 Apple Silicon Mac 本机运行，不需要 OpenAI、阿里云或其他付费 API：

```text
麦克风 / Chrome 标签页音频
           ↓ 16 kHz PCM
静音切句（停顿约 0.8 秒）
           ↓
MLX Whisper Small：中英文语音识别
           ↓
Qwen3 1.7B 4-bit：中 ↔ 英翻译
           ↓
网页双语字幕
```

项目还保留了可选的 `Qwen3.5 LiveTranslate` 百炼云端模式，方便比较真正流式同传的延迟，但它只是限期免费额度，不属于永久免费的默认方案。

## 为什么这样选模型

| 环节 | 默认模型 | 大小 | 选择理由 |
| --- | --- | ---: | --- |
| 语音识别 | `mlx-community/whisper-small-mlx` | 约 459 MB | 中英文识别成熟，MLX 能直接利用 Apple Silicon 统一内存与 GPU |
| 翻译 | `Qwen/Qwen3-1.7B-MLX-4bit` | 约 914 MB | Qwen 官方 4-bit MLX 权重，Apache 2.0，体积小，支持 100+ 语言；Demo 只开放中英 |
| 云端可选 | `qwen3.5-livetranslate-flash-realtime` | 无本地权重 | 专用实时翻译模型，能返回流式原文和译文，延迟更低 |

Qwen 官方也开源了 `Qwen3-ASR-0.6B/1.7B`，支持 52 种语言和方言。不过其高性能流式服务路线主要使用 vLLM/CUDA；当前这台 Apple Silicon Mac 上，MLX Whisper 更容易稳定运行，所以本地 Demo 采用“Whisper 识别 + Qwen 翻译”的两段式架构。若以后部署到 NVIDIA Linux 服务器，可以把识别层换成 Qwen3-ASR。

本地模型是“无需 API 账单”，不是零成本：需要约 1.4 GB 模型下载、一些磁盘空间和本机算力。模型下载后可断网推理。

## 已验证结果

在 16 GB Apple Silicon Mac 上，用系统合成的干净语音做了真实推理（不是 mock）：

- 英文音频 3.50 秒
  - 识别：`Good morning, today we will review the local translation demo.`
  - 翻译：`早上好，今天我们将回顾本地翻译演示。`
  - 首次加载模型后完成：约 4.6 秒
- 中文音频 4.34 秒
  - 识别：`大家好，今天我們測試本地的中英文會議翻譯。`
  - 翻译：`Hello everyone, today we are testing the local Chinese-to-English translation meeting.`
  - 模型热身后完成：约 0.6 秒

这只是功能验证，不是正式基准。真实会议中的噪音、重叠说话、口音和设备温度都会改变准确率与延迟。

## 五分钟启动本地免费模式

### 1. 环境要求

- Apple Silicon Mac（M1 或更新）
- macOS 13.5 或更新
- Python 3.10–3.13
- Node.js 20 或更新
- Chrome（标签页音频捕获兼容性最好）
- 首次安装需联网；运行模型时不需要联网

先确认版本：

```bash
python3 --version
node --version
```

### 2. 安装网页依赖

```bash
cd /Users/ming/zbm/qwen-live-translate-demo
npm install
```

### 3. 创建 Python 环境并安装本地推理依赖

```bash
npm run local:setup
```

它会创建项目内的 `.venv`，并安装 `mlx-whisper` 与 `mlx-lm`。`.venv` 已被 Git 忽略。

如果电脑上 `python3` 不是 3.10–3.13，请用正确的解释器手动执行：

```bash
/path/to/python3.12 -m venv .venv
.venv/bin/pip install -r local/requirements.txt
```

### 4. 提前下载模型（推荐）

```bash
npm run local:download
```

这会下载约 1.4 GB 权重，并做一次预加载。也可以跳过；跳过时，第一次说话才会下载，页面会等待更久。

### 5. 一键启动

```bash
npm run local
```

这个命令会同时启动：

- 本地 MLX 模型服务：`http://127.0.0.1:8765`
- Demo 网页与 WebSocket 服务：`http://127.0.0.1:8787`

用 Chrome 打开：

```text
http://127.0.0.1:8787
```

看到“本地模式就绪”即可开始。停止时在终端按 `Ctrl+C`，两个服务会一起退出。

## 页面如何使用

### 翻译麦克风

1. “运行方式”保留“完全本地 · 永久免费”。
2. 选择 `English → 中文` 或 `中文 → English`。
3. 声音来源选择“麦克风”。
4. 可选填写术语表，每行一条，例如：

   ```text
   Model Studio=百炼
   Qwen=通义千问
   ```

5. 点击“开始翻译”，允许 Chrome 使用麦克风。
6. 说一个完整句子并停顿约一秒。左侧随后显示识别原文，右侧显示 Qwen 译文。
7. 点击“停止并刷新最后一句”，等待状态恢复就绪。

本地模式不是逐字流式：它在检测到约 0.8 秒静音后送出一句，单句最长 15 秒。短句、清楚停顿和耳机麦克风效果最好。

### 翻译 Teams / Zoom / Meet 网页会议

1. 用 Chrome 打开会议或播放视频的标签页。
2. 在 Demo 中选择“标签页 / 系统音频”。
3. 点击“开始翻译”。
4. Chrome 弹出共享对话框后，选择正在发声的 **Chrome 标签页**。
5. 勾选“分享标签页音频”。

浏览器会要求一条视频共享轨道来启动标签页捕获，但 Demo 不读取或上传视频帧，只处理音频。

浏览器不保证能捕获桌面版 Teams/Zoom 应用的系统音频。当前最可靠的测试方式是网页版会议或 Chrome 视频标签页；正式 macOS 桌面 App 应改用 ScreenCaptureKit，Windows 应改用 WASAPI Loopback。

## 术语表的作用与限制

- 术语表的源词会作为 Whisper 的识别提示，也会作为 Qwen 的强制翻译映射。
- 每行格式是 `原词=译词`，最多 50 条。
- 它能提高产品名、人名和缩写的稳定性，但小模型仍可能先把罕见词听错；正式产品应增加拼写纠错或更大的 ASR 模型。

## 可选：百炼 Qwen 云端实时模式

云端模式不是永久免费的。Model Studio 国际区新用户当前有 100 万 token、90 天有效的免费额度；用完后按量计费。选择它的原因是端到端流式延迟更低，而不是“免费”。

### 配置

1. 在 Alibaba Cloud Model Studio 的 Singapore 区域创建 Workspace 和 API Key。
2. 复制环境变量模板：

   ```bash
   cp .env.example .env
   ```

3. 编辑 `.env`：

   ```dotenv
   DASHSCOPE_API_KEY=sk-your-real-key
   QWEN_WORKSPACE_ID=your-real-workspace-id
   QWEN_REGION=singapore
   ```

4. 运行 `npm run local`（同时保留本地模式），或只运行 `npm start`。
5. 页面上选择“百炼云端 · 免费额度”。

API Key 只保存在 Node 服务端，不会下发浏览器。云端模式会把音频发给百炼；本地模式不会。

## 配置项

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `LOCAL_ASR_MODEL` | `mlx-community/whisper-small-mlx` | 替换本地 ASR 权重 |
| `LOCAL_QWEN_MODEL` | `Qwen/Qwen3-1.7B-MLX-4bit` | 替换本地翻译权重 |
| `LOCAL_TRANSLATOR_URL` | `http://127.0.0.1:8765` | Node 连接本地模型服务的地址 |
| `DASHSCOPE_API_KEY` | 空 | 百炼云端模式的 Key |
| `QWEN_WORKSPACE_ID` | 空 | 百炼 Workspace ID |
| `QWEN_REGION` | `singapore` | `singapore` 或 `beijing` |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | Demo 网页监听地址 |

如果 1.7B 翻译质量不够，16 GB Mac 可以尝试更大的 4-bit Qwen 权重：

```bash
LOCAL_QWEN_MODEL=Qwen/Qwen3-4B-MLX-4bit npm run local
```

它会多占内存、磁盘并增加延迟，Demo 默认不自动下载。

## 自动测试

```bash
npm test
```

测试不调用任何云 API，当前包含 6 项：

- `.env` 解析
- 中英文与 provider 参数限制
- 本地音量/静音切句
- 浏览器 → 本地模型服务 → 双语字幕的完整代理链（假模型）
- Qwen 云端会话配置
- PCM Base64 转发、Authorization Header 与最后一句刷新

真实本地模型的中英语音推理已经另外手动验证，结果见上文。

## 常见问题

### 页面显示“本地模型未启动”

不要只运行 `npm start`。本地模式需要：

```bash
npm run local
```

首次使用先执行 `npm run local:setup`。

### 第一段字幕很慢

第一次会从磁盘加载约 1.4 GB 权重；若还未下载，也会连接 Hugging Face。先运行 `npm run local:download`。模型热身后会明显加快。

### 一直显示“正在聆听”

- 说完后停顿约一秒。
- 检查浏览器是否取得正确的麦克风/标签页音频权限。
- 会议音量太低时提高播放音量。
- 浏览器共享对话框必须勾选“分享标签页音频”。

### 识别正确但翻译不自然

1.7B 是为本地轻量 Demo 选择的折中。先添加术语表；仍不够时换 4B 权重，或者使用云端 Qwen3.5 LiveTranslate 做 A/B 测试。

### 能否直接听桌面版 Teams / Zoom

这个网页原型不保证。可先使用会议网页版；正式 App 需要原生音频捕获层。现有模型服务和字幕 UI 可以保留，只替换采集层。

## 隐私与生产化边界

- 本地模式只监听 `127.0.0.1`，不上传、不落盘音频与字幕。
- 浏览器只采集用户主动授权的来源。
- 会议录音/转写前必须取得参会者同意，并遵守当地法律和公司政策。
- 当前 Demo 没有账号、权限、字幕导出、说话人分离、会议历史或安装包。
- 生产版还需要代码签名、自动更新、崩溃恢复、设备选择、回声处理、说话人分离和数据保留设置。

## 主要文件

```text
server.mjs                 Node 网页服务、WebSocket、切句与双 provider 代理
public/                    浏览器 UI、音频捕获与 16 kHz PCM 重采样
local/local_server.py      MLX Whisper + Qwen3 本地推理服务
scripts/start-local.mjs    一键启动/停止两个本地服务
test/server.test.mjs       Node 集成测试
```

## 官方资料

- [Apple MLX](https://github.com/ml-explore/mlx)
- [MLX Whisper 示例](https://github.com/ml-explore/mlx-examples/tree/main/whisper)
- [MLX LM](https://github.com/ml-explore/mlx-lm)
- [Qwen 官方 Qwen3 1.7B MLX 4-bit 权重](https://huggingface.co/Qwen/Qwen3-1.7B-MLX-4bit)
- [Qwen3-ASR 开源项目](https://github.com/QwenLM/Qwen3-ASR)
- [Qwen3.5 LiveTranslate 云端文档](https://www.alibabacloud.com/help/en/model-studio/qwen3-5-livetranslate-flash-realtime)
- [Alibaba Cloud Model Studio 价格](https://www.alibabacloud.com/help/en/model-studio/model-pricing)
