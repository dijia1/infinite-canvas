package service

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss"
	"io"
	"math"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"time"
)

// Generated results are spooled to disk, never buffered in memory. Uploaded
// references use browser metadata and do not enter this probing path.
func probeVideoFile(ctx context.Context, path string) (float64, int, int, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "ffprobe", "-v", "error", "-protocol_whitelist", "file", "-select_streams", "v:0", "-show_entries", "format=duration,format_name:stream=width,height,codec_name", "-of", "json", path).Output()
	if err != nil {
		return 0, 0, 0, safeMessageError{message: "无法验证 MP4 视频，请确认格式或服务器 ffprobe 配置"}
	}
	var data struct {
		Format struct {
			Duration string `json:"duration"`
			Name     string `json:"format_name"`
		} `json:"format"`
		Streams []struct {
			Width  int    `json:"width"`
			Height int    `json:"height"`
			Codec  string `json:"codec_name"`
		} `json:"streams"`
	}
	if json.Unmarshal(output, &data) != nil || len(data.Streams) != 1 {
		return 0, 0, 0, errors.New("无效的视频文件")
	}
	duration, err := strconv.ParseFloat(data.Format.Duration, 64)
	if err != nil || math.IsNaN(duration) || math.IsInf(duration, 0) || duration <= 0 || data.Streams[0].Width <= 0 || data.Streams[0].Height <= 0 {
		return 0, 0, 0, errors.New("无效的视频时长或尺寸")
	}
	file, err := os.Open(path)
	if err != nil {
		return 0, 0, 0, err
	}
	defer file.Close()
	prefix := make([]byte, 512)
	n, _ := file.Read(prefix)
	if http.DetectContentType(prefix[:n]) != "video/mp4" {
		return 0, 0, 0, errors.New("仅支持 MP4 视频")
	}
	return duration, data.Streams[0].Width, data.Streams[0].Height, nil
}
func spoolVideo(reader io.Reader) (*os.File, error) {
	file, err := os.CreateTemp("", "canvas-video-*.mp4")
	if err != nil {
		return nil, err
	}
	n, err := io.Copy(file, io.LimitReader(reader, maxVideoBytes+1))
	if err != nil || n == 0 || n > maxVideoBytes {
		file.Close()
		os.Remove(file.Name())
		return nil, errors.New("视频大小无效，最大 100 MB")
	}
	return file, nil
}
func putVideoFile(ctx context.Context, store imageStore, key string, file *os.File) error {
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return err
	}
	info, err := file.Stat()
	if err != nil {
		return err
	}
	switch target := store.(type) {
	case *ossImageStore:
		_, err = target.internal.PutObject(ctx, &oss.PutObjectRequest{Bucket: oss.Ptr(target.bucket), Key: oss.Ptr(key), Body: file, ContentType: oss.Ptr("video/mp4"), ContentLength: oss.Ptr(info.Size()), Acl: oss.ObjectACLPrivate})
		return err
	default:
		return errors.New("视频需要配置 OSS 存储")
	}
}
func videoReferenceURL(ctx context.Context, store imageStore, key string) (string, error) {
	target, ok := store.(*ossImageStore)
	if !ok {
		return "", safeMessageError{message: "视频生成需要 OSS 存储"}
	}
	copy := *target
	copy.ttl = 2 * time.Hour
	url, _, err := copy.SignedURL(ctx, key, "")
	return url, err
}
