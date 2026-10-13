# Release Checklist

1. 确认 `package.json` 和 `package-lock.json` 版本号一致。
2. 本地验证：

```powershell
npm install
npm run dist
```

3. 提交代码：

```powershell
git add .
git commit -m "Release v0.3.0"
git push
```

4. 创建 tag：

```powershell
git tag v0.3.0
git push origin v0.3.0
```

5. 等待 GitHub Actions 自动构建并上传 Release 产物。
