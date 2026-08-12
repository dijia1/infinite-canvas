# 系统配置数据结构

系统配置保存在 `settings` 表中，目前只使用两行：

| key | 说明 |
| --- | --- |
| `public` | 公开配置，前端可以读取 |
| `private` | 私有配置，只给后端和管理员使用 |

## public.value

```json
{
  "modelChannel": {
    "availableModels": ["gpt-5.5", "gpt-image-2"],
    "defaultModel": "gpt-image-2",
    "defaultImageModel": "gpt-image-2",
    "defaultVideoModel": "grok-imagine-video",
    "defaultTextModel": "gpt-5.5",
    "systemPrompt": ""
  }
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `availableModels` | string[] | 管理员发布给公开端选择的模型 |
| `defaultModel` | string | 通用默认模型 |
| `defaultImageModel` | string | 默认图片模型 |
| `defaultVideoModel` | string | 默认视频模型 |
| `defaultTextModel` | string | 默认文本模型 |
| `systemPrompt` | string | 后端渠道统一使用的系统提示词 |

公开端只使用后端 `/api/v1/*` 云端代理，不保存或填写渠道 API Key。图片、视频和文本模型只能从 `availableModels` 中选择。

## private.value

```json
{
  "channels": [
    {
      "protocol": "openai",
      "name": "默认渠道",
      "baseUrl": "https://api.example.com",
      "apiKey": "sk-xxx",
      "models": ["gpt-5.5", "gpt-image-2"],
      "weight": 1,
      "enabled": true,
      "remark": ""
    }
  ]
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `channels` | object[] | 模型渠道列表 |

`channels` 每项字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `protocol` | string | 协议，当前为 `openai` |
| `name` | string | 渠道名称 |
| `baseUrl` | string | OpenAI 兼容接口地址 |
| `apiKey` | string | 渠道密钥，仅管理员可写，读取时隐藏 |
| `models` | string[] | 该渠道可用模型 |
| `weight` | number | 同一模型命中多个渠道时的随机权重 |
| `enabled` | boolean | 是否启用 |
| `remark` | string | 备注 |

后端调用模型时，会从已启用、已配置 `baseUrl` 和 `apiKey`、且 `models` 包含目标模型的渠道中选择一个。
