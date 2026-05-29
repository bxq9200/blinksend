# BlinkSend

BlinkSend 是一个面向 Windows 局域网的点对点文件传输桌面程序。它可以自动发现同一局域网内的设备，支持文件、文件夹、多文件队列、断点续传和传输历史，适合在多台 Windows 电脑之间快速互传素材、压缩包、工程文件和大体积资源。

![BlinkSend Logo](src/assets/logo.png)

## 功能特性

- 局域网自动发现设备
- 文件、文件夹、拖拽发送
- 多文件顺序队列，避免同时挤占局域网连接
- 文件夹批次一次确认，接收方不用逐个文件点击
- 大文件传输进度、速度和完成状态显示
- `.part` 临时文件断点续传
- 自定义接收目录，默认 `Downloads\BlinkSend`
- 最近 200 条传输历史
- 兼容旧版 `LAN Share` 发现协议
- Windows 便携版 exe，双击即用

## 下载

进入 GitHub Releases 下载 Windows 版本：

- `BlinkSend-Portable-0.2.4.exe`：便携版，双击即用，不需要安装。

## 快速开始

1. 在两台或多台 Windows 电脑上运行 BlinkSend。
2. 确保这些电脑处在同一个局域网内。
3. 如果 Windows 防火墙弹窗，允许 BlinkSend 访问专用网络。
4. 在左侧选择目标设备。
5. 点击“选择文件”或直接拖拽文件/文件夹到主区域。
6. 接收方点击“接收”，文件会保存到设置的接收目录。

## 本地开发

```powershell
git clone https://github.com/bxq9200/blinksend.git
cd blinksend
npm install
npm start
```

## 打包

生成 Windows 便携版：

```powershell
npm run dist
```

生成文件位于：

```text
dist\BlinkSend-Portable-0.2.4.exe
```

## 当前协议

- UDP `43111`：设备发现广播
- TCP `43112`：文件传输，端口占用时会自动选择可用端口并通过 UDP 广播

## 常见问题

### 设备互相看不到

请确认：

- 两台电脑处在同一个局域网。
- Windows 防火墙允许 BlinkSend 访问专用网络。
- 路由器没有开启 AP 隔离或客户端隔离。
- 没有被安全软件拦截 UDP 广播或 TCP 连接。

### 发送文件夹时为什么只确认一次

BlinkSend 会把同一次发送的多文件或文件夹标记为一个批次。接收方对第一个请求点击“接收”或“拒绝”后，同批次后续文件会自动沿用这个决定。

### 断点续传如何工作

接收端会先写入 `.part` 临时文件。如果传输中断，再次发送同名同路径文件时，BlinkSend 会从已有 `.part` 文件大小继续传输。完成后再改名为最终文件。

## Release 流程

1. 修改 `package.json` 和 `package-lock.json` 版本号。
2. 本地验证：

```powershell
npm install
npm run dist
```

3. 提交代码并推送：

```powershell
git add .
git commit -m "Release v0.2.4"
git push
```

4. 创建 tag：

```powershell
git tag v0.2.4
git push origin v0.2.4
```

5. GitHub Actions 会自动构建并上传 Release 产物。

## 技术栈

- Electron
- Node.js UDP/TCP
- 原生 HTML / CSS / JavaScript
- electron-builder

## 安全提醒

BlinkSend 面向可信局域网使用。当前版本没有端到端加密和身份配对，请不要在不可信网络中传输敏感文件。

## License

MIT
