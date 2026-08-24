package service

import (
	"context"
	"errors"
	"io"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/basketikun/infinite-canvas/ai"
	"github.com/basketikun/infinite-canvas/config"
)

type ImageTaskInput struct {
	ObjectKey   string `json:"objectKey"`
	Name        string `json:"name"`
	ContentType string `json:"contentType"`
}

var taskInputStoreFactory = newImageStore

func SaveImageTaskInputs(ctx context.Context, taskID string, references []ai.ImageReference) ([]ImageTaskInput, error) {
	if len(references) == 0 {
		return []ImageTaskInput{}, nil
	}
	store, err := taskInputStoreFactory()
	if err != nil {
		return nil, err
	}
	inputs := make([]ImageTaskInput, 0, len(references))
	for index, reference := range references {
		if len(reference.Data) == 0 || len(reference.Data) > maxMediaBytes {
			_ = DeleteImageTaskInputs(ctx, inputs)
			return nil, errors.New("参考图大小无效")
		}
		contentType, extension, err := normalizeImage(reference.Data, reference.ContentType)
		if err != nil {
			_ = DeleteImageTaskInputs(ctx, inputs)
			return nil, err
		}
		key := taskInputObjectKey(taskID, index, extension)
		if err := store.Put(ctx, key, reference.Data, contentType); err != nil {
			_ = DeleteImageTaskInputs(ctx, inputs)
			return nil, err
		}
		name := filepath.Base(strings.TrimSpace(reference.Name))
		if name == "." || name == "" {
			name = "reference." + extension
		}
		inputs = append(inputs, ImageTaskInput{ObjectKey: key, Name: name, ContentType: contentType})
	}
	return inputs, nil
}

func ReadImageTaskInputs(ctx context.Context, inputs []ImageTaskInput) ([]ai.ImageReference, error) {
	if len(inputs) == 0 {
		return []ai.ImageReference{}, nil
	}
	store, err := taskInputStoreFactory()
	if err != nil {
		return nil, err
	}
	references := make([]ai.ImageReference, 0, len(inputs))
	for _, input := range inputs {
		reader, err := store.Get(ctx, input.ObjectKey)
		if err != nil {
			return nil, err
		}
		data, readErr := io.ReadAll(io.LimitReader(reader, maxMediaBytes+1))
		_ = reader.Close()
		if readErr != nil || len(data) == 0 || len(data) > maxMediaBytes {
			return nil, errors.New("读取参考图失败")
		}
		references = append(references, ai.ImageReference{Name: input.Name, ContentType: input.ContentType, Data: data})
	}
	return references, nil
}

func DeleteImageTaskInputs(ctx context.Context, inputs []ImageTaskInput) error {
	if len(inputs) == 0 {
		return nil
	}
	store, err := taskInputStoreFactory()
	if err != nil {
		return err
	}
	for _, input := range inputs {
		if err := deleteImageObject(ctx, store, input.ObjectKey); err != nil {
			return err
		}
	}
	return nil
}

func taskInputObjectKey(taskID string, index int, extension string) string {
	prefix := strings.Trim(strings.TrimSpace(config.Cfg.OSSObjectPrefix), "/")
	if prefix == "" {
		prefix = "images"
	}
	extension = strings.TrimSpace(strings.TrimPrefix(extension, "."))
	if extension == "" {
		extension = "png"
	}
	return prefix + "/tasks/" + filepath.Base(taskID) + "/inputs/reference-" + strconv.Itoa(index) + "." + extension
}
