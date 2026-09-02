package handler

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/basketikun/infinite-canvas/service"
)

func UploadImage(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		Fail(w, "上传图片无效")
		return
	}
	file, header, err := r.FormFile("image")
	if err != nil {
		Fail(w, "请选择图片")
		return
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 50<<20+1))
	if err != nil {
		Fail(w, "读取图片失败")
		return
	}
	user, ok := service.PortalUserFromContext(r.Context())
	if !ok {
		Fail(w, "未经过 Portal Gateway 身份验证")
		return
	}
	result, err := service.SaveUploadedImage(r.Context(), user, header.Filename, header.Header.Get("Content-Type"), data, r.FormValue("intent"))
	if err != nil {
		FailError(w, err)
		return
	}
	service.RecordOperation(r.Context(), service.OperationLogInput{Action: "private_image_upload", TargetType: "media", TargetID: result.MediaID, TargetName: header.Filename, MediaIDs: []string{result.MediaID}})
	OK(w, result)
}

func MediaAccess(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := service.PortalUserFromContext(r.Context())
	if !ok {
		Fail(w, "未经过 Portal Gateway 身份验证")
		return
	}
	result, err := service.MediaAccessURL(r.Context(), user, id)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}

func DeletePrivateMedia(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := service.PortalUserFromContext(r.Context())
	if !ok {
		Fail(w, "未经过 Portal Gateway 身份验证")
		return
	}
	if err := service.DeletePrivateMedia(r.Context(), user, id); err != nil {
		FailError(w, err)
		return
	}
	service.RecordOperation(r.Context(), service.OperationLogInput{Action: "private_image_delete", TargetType: "media", TargetID: id})
	OK(w, true)
}

func PrivateImages(w http.ResponseWriter, r *http.Request) {
	user, ok := service.PortalUserFromContext(r.Context())
	if !ok {
		Fail(w, "未经过 Portal Gateway 身份验证")
		return
	}
	result, err := service.ListPrivateImages(r.Context(), user)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}

func UpdatePrivateImage(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := service.PortalUserFromContext(r.Context())
	if !ok {
		Fail(w, "未经过 Portal Gateway 身份验证")
		return
	}
	var input struct {
		Title    *string `json:"title"`
		FolderID *string `json:"folderId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		Fail(w, "请求参数无效")
		return
	}
	item, err := service.UpdatePrivateImage(r.Context(), user, id, input.Title, input.FolderID)
	if err != nil {
		FailError(w, err)
		return
	}
	action := "private_image_update"
	if input.Title != nil && input.FolderID == nil {
		action = "private_image_rename"
	} else if input.FolderID != nil && input.Title == nil {
		action = "private_image_move"
	}
	service.RecordOperation(r.Context(), service.OperationLogInput{Action: action, TargetType: "media", TargetID: item.ID, TargetName: item.Title, MediaIDs: []string{item.ID}})
	OK(w, item)
}

func PrivateFolders(w http.ResponseWriter, r *http.Request) {
	user, ok := service.PortalUserFromContext(r.Context())
	if !ok {
		Fail(w, "未经过 Portal Gateway 身份验证")
		return
	}
	result, err := service.ListPrivateFolders(r.Context(), user)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}

func CreatePrivateFolder(w http.ResponseWriter, r *http.Request) {
	user, ok := service.PortalUserFromContext(r.Context())
	if !ok {
		Fail(w, "未经过 Portal Gateway 身份验证")
		return
	}
	var input struct {
		Title    string `json:"title"`
		ParentID string `json:"parentId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		Fail(w, "请求参数无效")
		return
	}
	item, err := service.CreatePrivateFolder(r.Context(), user, input.Title, input.ParentID)
	if err != nil {
		FailError(w, err)
		return
	}
	service.RecordOperation(r.Context(), service.OperationLogInput{Action: "private_folder_create", TargetType: "private_folder", TargetID: item.ID, TargetName: item.Title})
	OK(w, item)
}

func RenamePrivateFolder(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := service.PortalUserFromContext(r.Context())
	if !ok {
		Fail(w, "未经过 Portal Gateway 身份验证")
		return
	}
	var input struct {
		Title string `json:"title"`
	}
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		Fail(w, "请求参数无效")
		return
	}
	item, err := service.RenamePrivateFolder(r.Context(), user, id, input.Title)
	if err != nil {
		FailError(w, err)
		return
	}
	service.RecordOperation(r.Context(), service.OperationLogInput{Action: "private_folder_rename", TargetType: "private_folder", TargetID: item.ID, TargetName: item.Title})
	OK(w, item)
}

func DeletePrivateFolder(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := service.PortalUserFromContext(r.Context())
	if !ok {
		Fail(w, "未经过 Portal Gateway 身份验证")
		return
	}
	if err := service.DeletePrivateFolder(r.Context(), user, id); err != nil {
		FailError(w, err)
		return
	}
	service.RecordOperation(r.Context(), service.OperationLogInput{Action: "private_folder_delete", TargetType: "private_folder", TargetID: id})
	OK(w, true)
}

func PublicImages(w http.ResponseWriter, r *http.Request) {
	result, err := service.ListPublicImages(parseQuery(r))
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}

func PublicFolders(w http.ResponseWriter, _ *http.Request) {
	result, err := service.ListPublicFolders()
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}

func PublicImageAccess(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := service.PortalUserFromContext(r.Context())
	if !ok {
		Fail(w, "未经过 Portal Gateway 身份验证")
		return
	}
	result, err := service.PublicImageAccessURL(r.Context(), user, id)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}

func LocalMediaContent(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := service.PortalUserFromContext(r.Context())
	if !ok {
		Fail(w, "未经过 Portal Gateway 身份验证")
		return
	}
	file, contentType, err := service.OpenLocalMedia(r.Context(), user, id)
	if err != nil {
		FailError(w, err)
		return
	}
	defer file.Close()
	w.Header().Set("Content-Type", contentType)
	_, _ = io.Copy(w, file)
}

func PublicImageContent(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := service.PortalUserFromContext(r.Context())
	if !ok {
		Fail(w, "未经过 Portal Gateway 身份验证")
		return
	}
	file, contentType, err := service.OpenPublicImage(r.Context(), user, id)
	if err != nil {
		FailError(w, err)
		return
	}
	defer file.Close()
	w.Header().Set("Content-Type", contentType)
	_, _ = io.Copy(w, file)
}

func AdminUploadPublicImage(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		Fail(w, "上传图片无效")
		return
	}
	file, header, err := r.FormFile("image")
	if err != nil {
		Fail(w, "请选择图片")
		return
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 50<<20+1))
	if err != nil {
		Fail(w, "读取图片失败")
		return
	}
	user, ok := service.PortalUserFromContext(r.Context())
	if !ok {
		Fail(w, "未经过 Portal Gateway 身份验证")
		return
	}
	item, access, err := service.SavePublicImage(r.Context(), user, header.Filename, header.Header.Get("Content-Type"), data, strings.TrimSpace(r.FormValue("title")), r.FormValue("folderId"))
	if err != nil {
		FailError(w, err)
		return
	}
	service.RecordOperation(r.Context(), service.OperationLogInput{Action: "public_image_upload", TargetType: "public_image", TargetID: item.ID, TargetName: item.Title, MediaIDs: []string{item.MediaID}})
	OK(w, map[string]any{"item": item, "access": access})
}

func AdminDeletePublicImage(w http.ResponseWriter, r *http.Request, id string) {
	if err := service.DeletePublicImage(r.Context(), id); err != nil {
		FailError(w, err)
		return
	}
	service.RecordOperation(r.Context(), service.OperationLogInput{Action: "public_image_delete", TargetType: "public_image", TargetID: id})
	OK(w, true)
}

func AdminCreatePublicFolder(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Title    string `json:"title"`
		ParentID string `json:"parentId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		Fail(w, "请求参数无效")
		return
	}
	item, err := service.CreatePublicFolder(input.Title, input.ParentID)
	if err != nil {
		FailError(w, err)
		return
	}
	service.RecordOperation(r.Context(), service.OperationLogInput{Action: "public_folder_create", TargetType: "public_folder", TargetID: item.ID, TargetName: item.Title})
	OK(w, item)
}

func AdminRenamePublicFolder(w http.ResponseWriter, r *http.Request, id string) {
	var input struct {
		Title string `json:"title"`
	}
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		Fail(w, "请求参数无效")
		return
	}
	item, err := service.RenamePublicFolder(id, input.Title)
	if err != nil {
		FailError(w, err)
		return
	}
	service.RecordOperation(r.Context(), service.OperationLogInput{Action: "public_folder_rename", TargetType: "public_folder", TargetID: id, TargetName: item.Title})
	OK(w, item)
}

func AdminDeletePublicFolder(w http.ResponseWriter, r *http.Request, id string) {
	if err := service.DeletePublicFolder(id); err != nil {
		FailError(w, err)
		return
	}
	service.RecordOperation(r.Context(), service.OperationLogInput{Action: "public_folder_delete", TargetType: "public_folder", TargetID: id})
	OK(w, true)
}

func AdminUpdatePublicImage(w http.ResponseWriter, r *http.Request, id string) {
	var input struct {
		Title    *string `json:"title"`
		FolderID *string `json:"folderId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		Fail(w, "请求参数无效")
		return
	}
	item, err := service.UpdatePublicImage(id, input.Title, input.FolderID)
	if err != nil {
		FailError(w, err)
		return
	}
	action := "public_image_update"
	if input.Title != nil && input.FolderID == nil {
		action = "public_image_rename"
	} else if input.FolderID != nil && input.Title == nil {
		action = "public_image_move"
	}
	service.RecordOperation(r.Context(), service.OperationLogInput{Action: action, TargetType: "public_image", TargetID: id, TargetName: item.Title, MediaIDs: []string{item.MediaID}})
	OK(w, item)
}

func PortalSession(w http.ResponseWriter, r *http.Request) {
	user, ok := service.PortalUserFromContext(r.Context())
	if !ok {
		Fail(w, "未经过 Portal Gateway 身份验证")
		return
	}
	OK(w, map[string]any{"user": map[string]any{"uid": user.UID, "username": user.Username, "displayName": service.PortalDisplayName(user), "roles": user.Roles}, "isAdmin": service.IsPortalAdmin(user)})
}
