# PushNow Python SDK

[English](README.md)

Python 3.10+ 和 Node.js 22+ 是必需运行环境。这是绑定到 Node HPKE runtime 的 Python SDK，不是原生 Python 加密实现。请阅读 [CONTRACT.md](CONTRACT.md) 了解完整信任模型、字段、限制、错误、定时和重试语义。

## 安装

发布到 PyPI 后：

```sh
pip install pushnow
```

本地开发：

```sh
cd sdk/python
npm --prefix runtime ci --ignore-scripts
python3 -m unittest discover -s tests -p 'test_*.py'
npm --prefix runtime test
```

安装包会包含 Node bridge runtime。部署机器还需要安装 runtime 中锁定的 npm 依赖。

## 使用账号 Token 授权

```python
import os
from pushnow import Client

client = Client()
pending = client.begin_account_authorization(
    "https://api.pushnow.dev",
    os.environ["PUSHNOW_ACCESS_TOKEN"],
    "Python automation",
)
print(pending["authorization"]["user_code"])
print(pending["fingerprint"])
config = client.authorize_account(pending)
```

账号 access token 来自已登录的 PushNow App 或可信 Dashboard 会话。token 只用于创建账号绑定授权，不能单独加密消息。不要打印完整 pending/config，因为里面包含私密凭据。

## 发送通知

```python
client = Client(config)
result = client.send(title="Build finished", body="The artifact is ready.", sound="chime")
```

SDK 会本地加密消息和附件。服务器不会看到明文标题、正文、文件名或附件密钥。

## 测试

```sh
python3 -m unittest discover -s tests -p 'test_*.py'
npm --prefix runtime test
```

测试证明本地 SDK 行为和 wire contract 兼容，不证明生产 APNs 设备可见送达。
