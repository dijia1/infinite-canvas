package service

import (
	"context"
	"errors"
	"io"
	"net/http"
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
	Purpose     string `json:"purpose,omitempty"`
}

type ImageTaskInputs struct {
	References []ai.ImageReference
	Mask       *ai.ImageReference
}

var taskInputStoreFactory = newImageStore

func SaveImageTaskInputs(ctx context.Context, taskID string, references []ai.ImageReference, mask *ai.ImageReference) ([]ImageTaskInput, error) {
	if len(references) == 0 && mask == nil {
		return []ImageTaskInput{}, nil
	}
	store, err := taskInputStoreFactory()
	if err != nil {
		return nil, err
	}
	inputs := make([]ImageTaskInput, 0, len(references)+1)
	for index, reference := range references {
		input, err := saveImageTaskInput(ctx, store, taskID, index, reference, "image")
		if err != nil {
			_ = DeleteImageTaskInputs(ctx, inputs)
			return nil, err
		}
		inputs = append(inputs, input)
	}
	if mask != nil {
		if strings.TrimSpace(mask.ContentType) != "image/png" || http.DetectContentType(mask.Data) != "image/png" {
			_ = DeleteImageTaskInputs(ctx, inputs)
			return nil, safeMessageError{message: "遮罩必须为 PNG 图片"}
		}
		input, err := saveImageTaskInput(ctx, store, taskID, len(inputs), *mask, "mask")
		if err != nil {
			_ = DeleteImageTaskInputs(ctx, inputs)
			return nil, err
		}
		inputs = append(inputs, input)
	}
	return inputs, nil
}

func saveImageTaskInput(ctx context.Context, store imageStore, taskID string, index int, reference ai.ImageReference, purpose string) (ImageTaskInput, error) {
	if len(reference.Data) == 0 || len(reference.Data) > maxMediaBytes {
		return ImageTaskInput{}, errors.New("参考图大小无效")
	}
	contentType, extension, err := normalizeImage(reference.Data, reference.ContentType)
	if err != nil {
		return ImageTaskInput{}, err
	}
	key := taskInputObjectKey(taskID, index, extension)
	if err := store.Put(ctx, key, reference.Data, contentType); err != nil {
		return ImageTaskInput{}, err
	}
	name := filepath.Base(strings.TrimSpace(reference.Name))
	if name == "." || name == "" {
		name = "reference." + extension
	}
	return ImageTaskInput{ObjectKey: key, Name: name, ContentType: contentType, Purpose: purpose}, nil
}

func ReadImageTaskInputs(ctx context.Context, inputs []ImageTaskInput) (ImageTaskInputs, error) {
	if len(inputs) == 0 {
		return ImageTaskInputs{References: []ai.ImageReference{}}, nil
	}
	store, err := taskInputStoreFactory()
	if err != nil {
		return ImageTaskInputs{}, err
	}
	loaded := ImageTaskInputs{References: make([]ai.ImageReference, 0, len(inputs))}
	for _, input := range inputs {
		reader, err := store.Get(ctx, input.ObjectKey)
		if err != nil {
			return ImageTaskInputs{}, err
		}
		data, readErr := io.ReadAll(io.LimitReader(reader, maxMediaBytes+1))
		_ = reader.Close()
		if readErr != nil || len(data) == 0 || len(data) > maxMediaBytes {
			return ImageTaskInputs{}, errors.New("读取参考图失败")
		}
		reference := ai.ImageReference{Name: input.Name, ContentType: input.ContentType, Data: data}
		switch input.Purpose {
		case "", "image":
			loaded.References = append(loaded.References, reference)
		case "mask":
			if loaded.Mask != nil {
				return ImageTaskInputs{}, errors.New("图片任务包含多个遮罩")
			}
			loaded.Mask = &reference
		default:
			return ImageTaskInputs{}, errors.New("图片任务输入类型无效")
		}
	}
	return loaded, nil
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
