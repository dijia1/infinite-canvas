package service

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"path/filepath"
	"strings"

	"github.com/basketikun/infinite-canvas/ai"
	"github.com/basketikun/infinite-canvas/repository"
)

var ErrGenerationRequestConflict = repository.ErrGenerationRequestConflict

const imageRequestHashVersion = 2

type imageTaskInputIdentity struct {
	Name        string `json:"name"`
	ContentType string `json:"contentType"`
	Digest      string `json:"sha256"`
}

type imageTaskRequestIdentity struct {
	Version           int                      `json:"version"`
	Kind              string                   `json:"kind"`
	ProviderID        string                   `json:"providerId"`
	Mode              string                   `json:"mode"`
	Prompt            string                   `json:"prompt"`
	Count             int                      `json:"count"`
	Quality           string                   `json:"quality"`
	Size              string                   `json:"size"`
	Resolution        string                   `json:"resolution"`
	OutputFormat      string                   `json:"outputFormat"`
	Background        string                   `json:"background"`
	ProviderOptions   ai.ImageRequestOptions   `json:"providerOptions"`
	ReferenceMediaIDs []string                 `json:"referenceMediaIds"`
	UploadedInputs    []imageTaskInputIdentity `json:"uploadedInputs"`
	Mask              *imageTaskInputIdentity  `json:"mask"`
}

type videoTaskRequestIdentity struct {
	Version       int      `json:"version"`
	Kind          string   `json:"kind"`
	ProviderID    string   `json:"providerId"`
	Prompt        string   `json:"prompt"`
	Seconds       int      `json:"seconds"`
	Size          string   `json:"size"`
	Resolution    string   `json:"resolution"`
	GenerateAudio bool     `json:"generateAudio"`
	ImageMediaIDs []string `json:"imageMediaIds"`
	VideoMediaIDs []string `json:"videoMediaIds"`
}

func imageTaskRequestHash(request CreateImageTaskRequest) (string, error) {
	providerOptions := request.Request.Options
	if providerOptions == nil {
		providerOptions = ai.ImageRequestOptions{}
	}
	identity := imageTaskRequestIdentity{
		Version: imageRequestHashVersion, Kind: "image", ProviderID: request.ProviderID, Mode: request.Mode,
		Prompt: request.Request.Prompt, Count: request.Request.Count, Quality: request.Request.Quality,
		Size: request.Request.Size, Resolution: request.Request.Resolution, OutputFormat: request.Request.OutputFormat,
		Background: request.Request.Background, ProviderOptions: providerOptions,
		ReferenceMediaIDs: append([]string{}, request.ReferenceMediaIDs...), UploadedInputs: []imageTaskInputIdentity{},
	}
	if identity.ReferenceMediaIDs == nil {
		identity.ReferenceMediaIDs = []string{}
	}
	if len(request.ReferenceMediaIDs) == 0 {
		for _, reference := range request.References {
			input, err := imageTaskReferenceIdentity(reference)
			if err != nil {
				return "", err
			}
			identity.UploadedInputs = append(identity.UploadedInputs, input)
		}
	}
	if request.Mask != nil {
		mask, err := imageTaskReferenceIdentity(*request.Mask)
		if err != nil {
			return "", err
		}
		identity.Mask = &mask
	}
	return canonicalRequestHash(identity)
}

func imageTaskReferenceIdentity(reference ai.ImageReference) (imageTaskInputIdentity, error) {
	contentType, extension, err := normalizeImage(reference.Data, reference.ContentType)
	if err != nil {
		return imageTaskInputIdentity{}, err
	}
	name := filepath.Base(strings.TrimSpace(reference.Name))
	if name == "" || name == "." {
		name = "reference." + extension
	}
	digest := sha256.Sum256(reference.Data)
	return imageTaskInputIdentity{Name: name, ContentType: contentType, Digest: hex.EncodeToString(digest[:])}, nil
}

func videoTaskRequestHash(request CreateVideoTaskRequest) (string, error) {
	imageMediaIDs := append([]string{}, request.ImageMediaIDs...)
	videoMediaIDs := append([]string{}, request.VideoMediaIDs...)
	if imageMediaIDs == nil {
		imageMediaIDs = []string{}
	}
	if videoMediaIDs == nil {
		videoMediaIDs = []string{}
	}
	return canonicalRequestHash(videoTaskRequestIdentity{
		Version: 1, Kind: "video", ProviderID: request.ProviderID, Prompt: request.Prompt,
		Seconds: request.Seconds, Size: request.Size, Resolution: request.Resolution, GenerateAudio: request.GenerateAudio,
		ImageMediaIDs: imageMediaIDs, VideoMediaIDs: videoMediaIDs,
	})
}

func canonicalRequestHash(identity any) (string, error) {
	encoded, err := json.Marshal(identity)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:]), nil
}
